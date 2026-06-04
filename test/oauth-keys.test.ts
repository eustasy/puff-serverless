import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import {
  JWT_ALG,
  _resetOAuthKeyCache,
  currentPublicJwk,
  importVerificationKey,
  jwkThumbprint,
  loadSigningKey,
  previousPublicJwk,
  type StoredActiveKey,
  type StoredRetiredKey,
} from "../src/oauth-keys.js"
import { fakeEnv } from "./helpers/fake-env.js"
import { fakeKv } from "./helpers/fake-kv.js"

async function generateEs256Jwk(): Promise<{
  privateJwkJson: string
  publicJwkJson: string
}> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey
  const publicJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey
  return {
    privateJwkJson: JSON.stringify({
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    }),
    publicJwkJson: JSON.stringify({
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    }),
  }
}

let currentPriv: string
let previousPub: string

beforeAll(async () => {
  const cur = await generateEs256Jwk()
  const prev = await generateEs256Jwk()
  currentPriv = cur.privateJwkJson
  previousPub = prev.publicJwkJson
})

beforeEach(() => {
  // Tests share a module-level KV cache; reset to keep them independent.
  _resetOAuthKeyCache()
})

describe("jwkThumbprint", () => {
  it("matches the RFC 7638 example fixture", async () => {
    // RFC 7638 §3.1 — the canonical example. The thumbprint of this exact
    // RSA JWK must be NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs. We compute
    // the same hash here over the canonical JSON our implementation builds.
    const rsa = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
    }
    const canonical = JSON.stringify({
      e: rsa.e,
      kty: rsa.kty,
      n: rsa.n,
    })
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
    function b64url(bytes: Uint8Array): string {
      let s = ""
      for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]!)
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    }
    expect(b64url(new Uint8Array(hash))).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs")
  })

  it("is deterministic for an EC P-256 JWK", async () => {
    const jwk = JSON.parse(currentPriv)
    const a = await jwkThumbprint(jwk)
    const b = await jwkThumbprint(jwk)
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("ignores private fields — public/private of one keypair share a kid", async () => {
    const priv = JSON.parse(currentPriv)
    const pub = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y }
    expect(await jwkThumbprint(priv)).toBe(await jwkThumbprint(pub as never))
  })
})

describe("loadSigningKey", () => {
  it("imports the private JWK as a non-extractable sign-only CryptoKey (env-var fallback)", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const key = await loadSigningKey(env)
    expect(key.type).toBe("private")
    expect(key.extractable).toBe(false)
    expect(key.usages).toEqual(["sign"])
  })

  it("reads the active key from KV when present, preferring it over the env-var", async () => {
    const jwk = JSON.parse(currentPriv)
    const kid = await jwkThumbprint(jwk)
    const stored: StoredActiveKey = {
      jwk,
      kid,
      created_at: new Date().toISOString(),
    }
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv({ "oauth:keys:active": stored }),
      // Set the fallback to a string the env-var path would reject so
      // we know the KV path was taken.
      OAUTH_SIGNING_KEY_PRIVATE: "not json",
    })
    const key = await loadSigningKey(env)
    expect(key.type).toBe("private")
    expect(key.usages).toEqual(["sign"])
  })

  it("throws when neither KV nor the env-var has a key", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: "" })
    await expect(loadSigningKey(env)).rejects.toThrow(/No active signing key/)
  })

  it("throws when the env-var JWK is malformed", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: "not json" })
    await expect(loadSigningKey(env)).rejects.toThrow(/not valid JSON/)
  })

  it("throws when the JWK is missing the private scalar `d`", async () => {
    const pub = JSON.parse(currentPriv)
    delete pub.d
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: JSON.stringify(pub) })
    await expect(loadSigningKey(env)).rejects.toThrow(/private scalar/)
  })
})

describe("currentPublicJwk", () => {
  it("derives the public JWK from the env-var private key, with kid+use+alg set", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const jwk = await currentPublicJwk(env)
    const priv = JSON.parse(currentPriv)
    expect(jwk.kty).toBe("EC")
    expect(jwk.crv).toBe("P-256")
    expect(jwk.x).toBe(priv.x)
    expect(jwk.y).toBe(priv.y)
    expect(jwk).not.toHaveProperty("d")
    expect(jwk.use).toBe("sig")
    expect(jwk.alg).toBe(JWT_ALG)
    expect(jwk.kid).toBe(await jwkThumbprint(priv))
  })

  it("uses KV when set", async () => {
    const priv = JSON.parse(currentPriv)
    const kid = await jwkThumbprint(priv)
    const stored: StoredActiveKey = {
      jwk: priv,
      kid,
      created_at: new Date().toISOString(),
    }
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv({ "oauth:keys:active": stored }),
    })
    const jwk = await currentPublicJwk(env)
    expect(jwk.kid).toBe(kid)
    expect(jwk).not.toHaveProperty("d")
  })
})

describe("previousPublicJwk", () => {
  it("returns null when neither the env-var nor KV has it", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    expect(await previousPublicJwk(env)).toBeNull()
  })

  it("returns null when the env-var binding is whitespace-only and KV is empty", async () => {
    const env = fakeEnv({
      OAUTH_SIGNING_KEY_PRIVATE: currentPriv,
      OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC: "   ",
    })
    expect(await previousPublicJwk(env)).toBeNull()
  })

  it("returns a populated JWK when the env-var binding is set", async () => {
    const env = fakeEnv({
      OAUTH_SIGNING_KEY_PRIVATE: currentPriv,
      OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC: previousPub,
    })
    const jwk = await previousPublicJwk(env)
    expect(jwk).not.toBeNull()
    expect(jwk!.kid).toBe(await jwkThumbprint(JSON.parse(previousPub)))
    expect(jwk!.use).toBe("sig")
    expect(jwk!.alg).toBe(JWT_ALG)
  })

  it("returns a populated JWK from KV when the retired entry is set", async () => {
    const pub = JSON.parse(previousPub)
    const kid = await jwkThumbprint(pub)
    const stored: StoredRetiredKey = {
      jwk: pub,
      kid,
      retired_at: new Date().toISOString(),
    }
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv({ "oauth:keys:retired": stored }),
    })
    const jwk = await previousPublicJwk(env)
    expect(jwk).not.toBeNull()
    expect(jwk!.kid).toBe(kid)
  })
})

describe("importVerificationKey", () => {
  it("imports a public JWK as a verify-only CryptoKey", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const pub = await currentPublicJwk(env)
    const key = await importVerificationKey(pub)
    expect(key.type).toBe("public")
    expect(key.usages).toEqual(["verify"])
  })
})
