import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb, pgError } from "./helpers/fake-db.js"

// verifyTotpLogin composes readToken/consumeToken (from tokens.ts) and otplib's
// `verify`. Mock those so the branch logic can be driven directly; read2fa and
// used2fa stay real and run against FakeDb.
const mocks = vi.hoisted(() => ({
  readToken: vi.fn(),
  consumeToken: vi.fn(),
  verify: vi.fn(),
}))
vi.mock("../src/tokens.js", () => ({ readToken: mocks.readToken, consumeToken: mocks.consumeToken }))
vi.mock("otplib", () => ({ verify: mocks.verify }))

const { create2fa, read2fa, delete2fa, has2fa, enable2fa, used2fa, verifyTotpLogin } = await import("../src/2fa.js")

describe("create2fa", () => {
  it("inserts a disabled totp_secret and returns the new row", async () => {
    const db = new FakeDb()
    const row = { user_uuid: "user-1", secret_type: "totp_secret" }
    db.on(/INSERT INTO secrets/, { rows: [row] })
    const result = await create2fa(db.client, "user-1", "BASE32SECRET", "Phone")
    expect(result).toMatchObject({ success: true, twoFactor: row })
    expect(db.calls[0].values[2]).toBe("totp_secret")
    expect(db.calls[0].values[3]).toBe("BASE32SECRET")
    expect(db.calls[0].values[4]).toBe("Phone")
  })

  it("defaults the secret name to null", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO secrets/, { rows: [{}] })
    await create2fa(db.client, "user-1", "BASE32SECRET")
    expect(db.calls[0].values[4]).toBeNull()
  })

  it("returns an error envelope when the insert throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO secrets/, pgError("23505"))
    expect((await create2fa(db.client, "u", "s")).status).toBe(500)
  })

  it("returns 500 when the insert returns no rows", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO secrets/, { rows: [] })
    expect((await create2fa(db.client, "u", "s")).status).toBe(500)
  })
})

describe("read2fa", () => {
  it("returns the totp secret record when present", async () => {
    const db = new FakeDb()
    const row = { user_uuid: "user-1", is_enabled: true }
    db.on(/FROM secrets/, { rows: [row] })
    expect(await read2fa(db.client, "user-1")).toMatchObject({
      success: true,
      twoFactor: row,
    })
  })

  it("returns a 404 envelope when 2FA is not configured", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [] })
    expect(await read2fa(db.client, "user-1")).toMatchObject({
      success: false,
      status: 404,
    })
  })

  it("returns 500 when the select throws", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, pgError("08006"))
    expect((await read2fa(db.client, "user-1")).status).toBe(500)
  })
})

describe("delete2fa", () => {
  it("reports the number of rows removed", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM secrets/, { rowCount: 1 })
    expect(await delete2fa(db.client, "user-1")).toEqual({
      success: true,
      rowCount: 1,
      status: 200,
    })
  })

  it("returns 500 when the delete throws", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM secrets/, pgError("08006"))
    expect((await delete2fa(db.client, "user-1")).status).toBe(500)
  })
})

describe("has2fa", () => {
  it("reports enabled: true when an enabled secret exists", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1/, { rows: [{ "?column?": 1 }] })
    expect(await has2fa(db.client, "user-1")).toEqual({
      success: true,
      enabled: true,
      status: 200,
    })
  })

  it("reports enabled: false when there is no enabled secret", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1/, { rows: [] })
    expect(await has2fa(db.client, "user-1")).toMatchObject({ enabled: false })
  })

  it("returns 500 when the select throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1/, pgError("08006"))
    expect((await has2fa(db.client, "user-1")).status).toBe(500)
  })
})

describe("enable2fa", () => {
  it("marks the secret enabled and returns the updated row", async () => {
    const db = new FakeDb()
    const row = { user_uuid: "user-1", is_enabled: true }
    db.on(/UPDATE secrets/, { rows: [row] })
    expect(await enable2fa(db.client, "user-1")).toMatchObject({
      success: true,
      record: row,
    })
  })

  it("returns 404 when there is no secret to enable", async () => {
    const db = new FakeDb()
    db.on(/UPDATE secrets/, { rows: [] })
    expect(await enable2fa(db.client, "user-1")).toMatchObject({
      success: false,
      status: 404,
    })
  })

  it("returns 500 when the update throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE secrets/, pgError("08006"))
    expect((await enable2fa(db.client, "user-1")).status).toBe(500)
  })
})

describe("used2fa", () => {
  it("records a fresh code and stamps last-used", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO totp_used_codes/, { rowCount: 1 })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    expect(await used2fa(db.client, "user-1", "123456")).toEqual({
      success: true,
      status: 200,
    })
    // The replay-guard insert, then the last-used stamp.
    expect(db.calls.map((c) => c.text.split(" ").slice(0, 2).join(" "))).toEqual(["INSERT INTO", "UPDATE secrets"])
  })

  it("rejects a replayed code (insert conflict) without stamping last-used", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO totp_used_codes/, { rowCount: 0 })
    expect(await used2fa(db.client, "user-1", "123456")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(1)
  })

  it("returns 500 when the insert throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO totp_used_codes/, pgError("08006"))
    expect((await used2fa(db.client, "user-1", "123456")).status).toBe(500)
  })
})

describe("verifyTotpLogin", () => {
  const futureIso = () => new Date(Date.now() + 60_000).toISOString()
  const validToken = () => ({
    success: true,
    token: { user_uuid: "user-1", token_type: "totp_verification_pending", expires_at: futureIso(), is_used: false },
  })

  // Scripts read2fa (real) + used2fa (real) for the happy path through the function.
  function dbForHappyPath(): FakeDb {
    const db = new FakeDb()
    db.on(/FROM secrets/, {
      rows: [{ secret_value: "sim_encrypted::THESECRET", is_enabled: true, secret_type: "totp_secret", user_uuid: "user-1" }],
    })
    db.on(/INSERT INTO totp_used_codes/, { rowCount: 1 })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    return db
  }

  beforeEach(() => {
    mocks.readToken.mockReset().mockResolvedValue(validToken())
    mocks.consumeToken.mockReset().mockResolvedValue({ success: true })
    mocks.verify.mockReset().mockResolvedValue({ valid: true })
  })

  it("verifies the code, records it, consumes the token and returns the user", async () => {
    const client = dbForHappyPath().client
    const r = await verifyTotpLogin(client, "tok", "123456")
    expect(r).toEqual({ success: true, user_uuid: "user-1", status: 200 })
    expect(mocks.consumeToken).toHaveBeenCalledWith(client, "tok", "totp_verification_pending")
  })

  it("rejects when the token cannot be read", async () => {
    mocks.readToken.mockResolvedValue({ success: false })
    const r = await verifyTotpLogin(new FakeDb().client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("rejects a token of the wrong type", async () => {
    mocks.readToken.mockResolvedValue({
      success: true,
      token: { user_uuid: "u", token_type: "password_reset", expires_at: futureIso(), is_used: false },
    })
    const r = await verifyTotpLogin(new FakeDb().client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("rejects an expired token", async () => {
    mocks.readToken.mockResolvedValue({
      success: true,
      token: {
        user_uuid: "u",
        token_type: "totp_verification_pending",
        expires_at: new Date(Date.now() - 1000).toISOString(),
        is_used: false,
      },
    })
    const r = await verifyTotpLogin(new FakeDb().client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("rejects an already-used token", async () => {
    mocks.readToken.mockResolvedValue({
      success: true,
      token: { user_uuid: "u", token_type: "totp_verification_pending", expires_at: futureIso(), is_used: true },
    })
    const r = await verifyTotpLogin(new FakeDb().client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("rejects when 2FA is not configured for the account", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [] }) // read2fa → 404
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("rejects when the secret exists but is not enabled", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [{ secret_value: "sim_encrypted::S", is_enabled: false }] })
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("returns 500 for an unexpectedly-formatted secret", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [{ secret_value: "PLAINTEXT", is_enabled: true }] })
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("returns 401 for a wrong TOTP code (token stays valid)", async () => {
    mocks.verify.mockResolvedValue({ valid: false })
    const db = dbForHappyPath()
    const r = await verifyTotpLogin(db.client, "tok", "000000")
    expect(r).toMatchObject({ success: false, status: 401 })
    expect(mocks.consumeToken).not.toHaveBeenCalled()
  })

  it("rejects a replayed code with 400", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [{ secret_value: "sim_encrypted::S", is_enabled: true }] })
    db.on(/INSERT INTO totp_used_codes/, { rowCount: 0 }) // used2fa → replay (success:false)
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
    expect(mocks.consumeToken).not.toHaveBeenCalled()
  })

  it("returns 500 when replay prevention itself errors", async () => {
    const db = new FakeDb()
    db.on(/FROM secrets/, { rows: [{ secret_value: "sim_encrypted::S", is_enabled: true }] })
    db.on(/INSERT INTO totp_used_codes/, pgError("08006")) // used2fa → error envelope
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("rejects when the token can no longer be consumed (concurrent use)", async () => {
    mocks.consumeToken.mockResolvedValue({ success: false })
    const db = dbForHappyPath()
    const r = await verifyTotpLogin(db.client, "tok", "123456")
    expect(r).toMatchObject({ success: false, status: 400 })
  })
})
