import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { signJwt, verifyJwt } from "../src/oauth-jwt.js"
import {
  JWT_ALG,
  _resetOAuthKeyCache,
  currentPublicJwk,
} from "../src/oauth-keys.js"
import { fakeEnv } from "./helpers/fake-env.js"

async function generateEs256Jwk(): Promise<{
  privateJwkJson: string
  publicJwkJson: string
}> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    privateKey
  )) as JsonWebKey
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    publicKey
  )) as JsonWebKey
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
let currentPubOnly: string
let previousPriv: string
let previousPubOnly: string

beforeAll(async () => {
  const cur = await generateEs256Jwk()
  const prev = await generateEs256Jwk()
  currentPriv = cur.privateJwkJson
  currentPubOnly = cur.publicJwkJson
  previousPriv = prev.privateJwkJson
  previousPubOnly = prev.publicJwkJson
})

beforeEach(() => {
  // `oauth-keys.ts` caches KV / env-var reads at module scope; tests here
  // swap envs between cases, so clear the cache before each.
  _resetOAuthKeyCache()
})

describe("signJwt", () => {
  it("produces a three-part token with ES256/kid in the header", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const token = await signJwt(env, { sub: "user-1" })
    const parts = token.split(".")
    expect(parts).toHaveLength(3)
    const header = JSON.parse(
      Buffer.from(parts[0]!, "base64url").toString("utf8")
    )
    const pub = await currentPublicJwk(env)
    expect(header.alg).toBe(JWT_ALG)
    expect(header.typ).toBe("JWT")
    expect(header.kid).toBe(pub.kid)
  })

  it("encodes the payload verbatim", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const payload = {
      sub: "user-1",
      iss: "https://example.test",
      exp: 1700000000,
      scope: ["openid", "profile"],
    }
    const token = await signJwt(env, payload)
    const decoded = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    )
    expect(decoded).toEqual(payload)
  })
})

describe("verifyJwt — happy path", () => {
  it("verifies a token signed by the current key and returns the payload", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const token = await signJwt(env, { sub: "user-1", exp: 1700000000 })
    const result = await verifyJwt(env, token)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload).toEqual({ sub: "user-1", exp: 1700000000 })
      const pub = await currentPublicJwk(env)
      expect(result.kid).toBe(pub.kid)
    }
  })

  it("verifies a token signed by the previous key during rotation overlap", async () => {
    // Sign with the previous key (acting as if it were current at the time).
    const signingEnv = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: previousPriv })
    const token = await signJwt(signingEnv, { sub: "user-1" })

    // Now the active key is the new one, but the previous public is exposed
    // for the overlap window. Verification must still succeed.
    const verifyingEnv = fakeEnv({
      OAUTH_SIGNING_KEY_PRIVATE: currentPriv,
      OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC: previousPubOnly,
    })
    const result = await verifyJwt(verifyingEnv, token)
    expect(result.success).toBe(true)
  })
})

describe("verifyJwt — rejections", () => {
  it("rejects a token signed by a key not in current or previous", async () => {
    const signingEnv = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: previousPriv })
    const token = await signJwt(signingEnv, { sub: "user-1" })

    // Verifying env has only the current key; no previous configured.
    const verifyingEnv = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const result = await verifyJwt(verifyingEnv, token)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.message).toMatch(/kid/)
    }
  })

  it("rejects a token whose payload has been tampered with", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const token = await signJwt(env, { sub: "user-1" })
    const [h, , s] = token.split(".") as [string, string, string]
    const tampered = `${h}.${Buffer.from('{"sub":"admin"}').toString(
      "base64url"
    )}.${s}`
    const result = await verifyJwt(env, tampered)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.message).toMatch(/signature/)
    }
  })

  it("rejects a malformed token", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const result = await verifyJwt(env, "not.a.jwt.token")
    expect(result.success).toBe(false)
  })

  it("rejects a token with an unsupported alg", async () => {
    const env = fakeEnv({ OAUTH_SIGNING_KEY_PRIVATE: currentPriv })
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: "x" })
    ).toString("base64url")
    const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString(
      "base64url"
    )
    const result = await verifyJwt(env, `${header}.${payload}.sig`)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.message).toMatch(/alg/)
    }
  })

  // Quiet the linter — currentPubOnly is exported only for parallel symmetry
  // with previousPubOnly in this fixture.
  it("exposes the current public JWK fixture for adjacent tests", () => {
    expect(JSON.parse(currentPubOnly).kty).toBe("EC")
  })
})
