import { describe, it, expect, vi, beforeEach } from "vitest"
import { fakeEnv } from "./helpers/fake-env.js"
import { fakeKv } from "./helpers/fake-kv.js"
import { _resetOAuthKeyCache, jwkThumbprint, type StoredActiveKey, type StoredRetiredKey } from "../src/oauth-keys.js"

// Mock the audit dispatcher so a rotation test doesn't try to open a real
// pg client. The rotation module opens its own short-lived `Client` inside
// `withAuditClient`, which we also mock.
const { queryMock, connectMock, endMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  endMock: vi.fn(),
}))
vi.mock("pg", () => ({
  Client: class {
    connect = connectMock
    end = endMock
    query = queryMock
  },
}))

const { maybeRotateSigningKey, rotateSigningKey, promoteRetiredKey } = await import("../src/oauth-keys-rotation.js")

beforeEach(() => {
  _resetOAuthKeyCache()
  queryMock.mockReset().mockResolvedValue({ rowCount: 1 })
  connectMock.mockReset().mockResolvedValue(undefined)
  endMock.mockReset().mockResolvedValue(undefined)
})

describe("rotateSigningKey", () => {
  it("writes the new active key with a kid and created_at, no retired when first run", async () => {
    const kv = fakeKv()
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    const result = await rotateSigningKey(env, { trigger: "manual" })

    expect(result.rotated).toBe(true)
    expect(result.new_kid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.retired_kid).toBeUndefined()

    const active = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    expect(active.kid).toBe(result.new_kid)
    expect(typeof active.jwk.d).toBe("string")
    expect(Date.parse(active.created_at)).toBeGreaterThan(0)
    expect(await kv.get("oauth:keys:retired", "json")).toBeNull()
  })

  it("promotes the existing active to retired (public-only, TTL'd)", async () => {
    const kv = fakeKv()
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    const first = await rotateSigningKey(env)
    _resetOAuthKeyCache()
    kv._resetCalls()
    const second = await rotateSigningKey(env)

    expect(second.retired_kid).toBe(first.new_kid)

    const retiredCall = kv._calls.put.find((c) => c.key === "oauth:keys:retired")
    expect(retiredCall).toBeDefined()
    expect((retiredCall!.options as { expirationTtl?: number }).expirationTtl).toBe(7200)

    const retired = (await kv.get("oauth:keys:retired", "json")) as StoredRetiredKey
    expect(retired.jwk.d).toBeUndefined()
    expect(retired.kid).toBe(first.new_kid)

    const active = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    expect(active.kid).toBe(second.new_kid)
    expect(active.kid).not.toBe(first.new_kid)
  })

  it("writes a 'oauth.signing_key.rotated' audit row on success", async () => {
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    await rotateSigningKey(env, { trigger: "manual" })

    const auditInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO audit_events"))
    expect(auditInserts.length).toBe(1)
    const params = auditInserts[0]![1] as unknown[]
    expect(params[1]).toBe("oauth.signing_key.rotated")
    expect(params[2]).toBe("alert")
  })

  it("throws when KV_OAUTH_KEYS is missing", async () => {
    const env = fakeEnv({
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    await expect(rotateSigningKey(env)).rejects.toThrow(/KV_OAUTH_KEYS binding missing/)
  })

  it("emits a failure audit and rethrows when keypair self-verification fails", async () => {
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    // Make crypto.subtle.sign throw so assertKeypairUsable bails out.
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockRejectedValueOnce(new Error("sign hardware failure"))

    await expect(rotateSigningKey(env)).rejects.toThrow("sign hardware failure")
    signSpy.mockRestore()

    const auditInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO audit_events"))
    expect(auditInserts.length).toBe(1)
    expect(auditInserts[0]![1][1]).toBe("oauth.signing_key.rotation.failed")
    expect(auditInserts[0]![1][3]).toBe("failure")
  })

  it("still succeeds (skips audit) when HYPERDRIVE is missing", async () => {
    // withAuditClient returns early — no pg client opened, rotation completes.
    const env = fakeEnv({ KV_OAUTH_KEYS: fakeKv() })
    const result = await rotateSigningKey(env)
    expect(result.rotated).toBe(true)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("still succeeds when the audit INSERT query throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("DB unavailable"))
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await rotateSigningKey(env)
    expect(result.rotated).toBe(true)
  })

  it("still succeeds when the audit client end() throws", async () => {
    endMock.mockRejectedValueOnce(new Error("end failed"))
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await rotateSigningKey(env)
    expect(result.rotated).toBe(true)
  })
})

describe("maybeRotateSigningKey", () => {
  it("rotates immediately when no active key exists", async () => {
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await maybeRotateSigningKey(env, { cron: "0 0 * * *" })
    expect(result.rotated).toBe(true)
  })

  it("skips when the active key is younger than the rotation interval", async () => {
    const kv = fakeKv()
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      OAUTH_KEY_ROTATION_INTERVAL_DAYS: "30",
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    await rotateSigningKey(env)

    queryMock.mockClear()
    const result = await maybeRotateSigningKey(env)
    expect(result.rotated).toBe(false)
    expect(result.reason).toMatch(/below interval/)
    const auditInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO audit_events"))
    expect(auditInserts.length).toBe(0)
  })

  it("rotates when the active key is older than the rotation interval", async () => {
    const kv = fakeKv()
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      OAUTH_KEY_ROTATION_INTERVAL_DAYS: "30",
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    await rotateSigningKey(env)

    // Backdate the active key by 31 days.
    const stored = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    stored.created_at = new Date(Date.now() - 31 * 86_400 * 1000).toISOString()
    await kv.put("oauth:keys:active", JSON.stringify(stored))

    const result = await maybeRotateSigningKey(env)
    expect(result.rotated).toBe(true)
  })

  it("returns rotated=false when KV is missing rather than throwing", async () => {
    const env = fakeEnv({
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await maybeRotateSigningKey(env)
    expect(result.rotated).toBe(false)
    expect(result.reason).toMatch(/KV_OAUTH_KEYS/)
  })

  it("treats a non-numeric rotation interval as the 7-day default and rotates when key is 8 days old", async () => {
    const kv = fakeKv()
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      OAUTH_KEY_ROTATION_INTERVAL_DAYS: "not-a-number",
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    await rotateSigningKey(env)

    const stored = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    stored.created_at = new Date(Date.now() - 8 * 86_400 * 1000).toISOString()
    await kv.put("oauth:keys:active", JSON.stringify(stored))

    // 8 days > 7-day default → should rotate.
    const result = await maybeRotateSigningKey(env)
    expect(result.rotated).toBe(true)
  })
})

describe("promoteRetiredKey", () => {
  it("throws when KV_OAUTH_KEYS is missing", async () => {
    const env = fakeEnv({ HYPERDRIVE: { connectionString: "postgres://localhost/test" } })
    await expect(promoteRetiredKey(env)).rejects.toThrow(/KV_OAUTH_KEYS binding missing/)
  })

  it("returns promoted=false when no retired key is held", async () => {
    const env = fakeEnv({
      KV_OAUTH_KEYS: fakeKv(),
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await promoteRetiredKey(env)
    expect(result.promoted).toBe(false)
  })

  it("refuses to promote a public-only retired key (no signing scalar)", async () => {
    const pubOnly = { kty: "EC", crv: "P-256", x: "abc", y: "def" }
    const kv = fakeKv({
      "oauth:keys:retired": {
        jwk: pubOnly,
        kid: "fakekid",
        retired_at: new Date().toISOString(),
      },
    })
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })
    const result = await promoteRetiredKey(env)
    expect(result.promoted).toBe(false)
    expect(result.reason).toMatch(/public-only/)
  })

  it("swaps active and retired when the retired entry has a private scalar", async () => {
    // Generate two real keypairs so the import in `oauth-keys.ts` succeeds.
    const pair1 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
    const pair2 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
    const exportPriv = async (k: CryptoKey) => {
      const jwk = (await crypto.subtle.exportKey("jwk", k)) as JsonWebKey
      return {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
        d: jwk.d,
      }
    }
    const activeJwk = await exportPriv(pair1.privateKey)
    const retiredJwk = await exportPriv(pair2.privateKey)
    const activeKid = await jwkThumbprint(activeJwk as never)
    const retiredKid = await jwkThumbprint(retiredJwk as never)

    const kv = fakeKv({
      "oauth:keys:active": {
        jwk: activeJwk,
        kid: activeKid,
        created_at: new Date().toISOString(),
      },
      "oauth:keys:retired": {
        jwk: retiredJwk,
        kid: retiredKid,
        retired_at: new Date().toISOString(),
      },
    })
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    const result = await promoteRetiredKey(env, { actor_user_uuid: "u1" })
    expect(result.promoted).toBe(true)
    expect(result.new_kid).toBe(retiredKid)

    const newActive = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    expect(newActive.kid).toBe(retiredKid)
    const newRetired = (await kv.get("oauth:keys:retired", "json")) as StoredRetiredKey
    expect(newRetired.kid).toBe(activeKid)
    // The replacement retired entry is public-only.
    expect(newRetired.jwk.d).toBeUndefined()

    const auditInserts = queryMock.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO audit_events"))
    expect(auditInserts.length).toBe(1)
    expect(auditInserts[0]![1][1]).toBe("oauth.signing_key.retired.promoted")
  })

  it("promotes retired and deletes the retired KV slot when there is no active key", async () => {
    // Seed only a retired entry (with a private scalar so it passes the guard).
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
    const retiredJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }
    const retiredKid = await jwkThumbprint(retiredJwk as never)

    const kv = fakeKv({
      "oauth:keys:retired": { jwk: retiredJwk, kid: retiredKid, retired_at: new Date().toISOString() },
      // no "oauth:keys:active"
    })
    const env = fakeEnv({
      KV_OAUTH_KEYS: kv,
      HYPERDRIVE: { connectionString: "postgres://localhost/test" },
    })

    const result = await promoteRetiredKey(env)
    expect(result.promoted).toBe(true)
    expect(result.new_kid).toBe(retiredKid)

    const newActive = (await kv.get("oauth:keys:active", "json")) as StoredActiveKey
    expect(newActive.kid).toBe(retiredKid)
    // The retired slot was deleted (else branch), so there is no new retired entry.
    expect(await kv.get("oauth:keys:retired", "json")).toBeNull()
  })
})
