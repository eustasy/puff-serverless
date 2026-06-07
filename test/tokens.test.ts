import { describe, it, expect } from "vitest"
import {
  createToken,
  readToken,
  usedToken,
  consumeToken,
  deleteToken,
  createEmailToken,
  createPasswordToken,
  createLoginToken,
  createPasswordUpgradeToken,
  createBypassToken,
  createSudoToken,
  createWebAuthnToken,
} from "../src/tokens.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Hours between now and an ISO timestamp — for asserting token TTLs.
function hoursUntil(iso: unknown): number {
  return (new Date(iso as string).getTime() - Date.now()) / 3_600_000
}

describe("createToken", () => {
  it("inserts a token with a generated UUID value and returns it", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", { rows: [{ token_value: "ignored" }] })

    const result = await createToken(db.client, "user-1", "email_verification", "2099-01-01T00:00:00.000Z", "a@b.test")

    expect(result).toMatchObject({ success: true })
    if (!result.success) throw new Error("expected success")
    expect(result.token_value).toMatch(UUID_RE)
    // The generated UUID is the value bound into the INSERT.
    expect(db.calls[0].values[2]).toBe(result.token_value)
    expect(db.calls[0].values).toEqual(["user-1", "email_verification", result.token_value, "2099-01-01T00:00:00.000Z", "a@b.test"])
  })

  it("defaults email_address to null", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", { rows: [{ token_value: "x" }] })
    await createToken(db.client, "user-1", "sudo_elevation", "2099-01-01")
    expect(db.calls[0].values[4]).toBeNull()
  })

  it("returns an error envelope when the insert affects no rows", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", { rows: [] })
    const result = await createToken(db.client, "u", "t", "2099-01-01")
    expect(result).toMatchObject({ error: true })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", pgError("08006", "connection lost"))
    const result = await createToken(db.client, "u", "t", "2099-01-01")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while creating token.",
    })
  })
})

describe("readToken", () => {
  it("returns the token record when found", async () => {
    const db = new FakeDb()
    const row = {
      user_uuid: "u1",
      email_address: "a@b.test",
      token_type: "password_reset",
      expires_at: new Date(),
      is_used: false,
    }
    db.on(/SELECT .* FROM tokens/, { rows: [row] })
    const result = await readToken(db.client, "tok")
    expect(result).toMatchObject({ success: true, token: row })
  })

  it("returns an error envelope when the token is not found", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM tokens/, { rows: [] })
    expect(await readToken(db.client, "tok")).toMatchObject({
      error: true,
      message: "Token not found.",
    })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM tokens/, pgError("08006", "connection lost"))
    const result = await readToken(db.client, "tok")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while reading token.",
    })
  })
})

describe("usedToken", () => {
  it("reports success when a row was updated", async () => {
    const db = new FakeDb()
    db.on("UPDATE tokens SET is_used", { rowCount: 1 })
    expect(await usedToken(db.client, "tok")).toEqual({
      success: true,
      rowCount: 1,
    })
  })

  it("reports success: false when no row matched", async () => {
    const db = new FakeDb()
    db.on("UPDATE tokens SET is_used", { rowCount: 0 })
    expect(await usedToken(db.client, "tok")).toEqual({
      success: false,
      rowCount: 0,
    })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on("UPDATE tokens SET is_used", pgError("08006", "connection lost"))
    const result = await usedToken(db.client, "tok")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while updating token.",
    })
  })
})

describe("consumeToken", () => {
  it("returns the token when it is valid, unused and of the expected type", async () => {
    const db = new FakeDb()
    const row = {
      user_uuid: "u1",
      email_address: null,
      token_type: "email_verification",
      expires_at: new Date(),
      is_used: true,
    }
    db.on("UPDATE tokens SET is_used = TRUE", { rows: [row] })
    const result = await consumeToken(db.client, "tok", "email_verification")
    expect(result).toMatchObject({ success: true, token: row })
    expect(db.calls[0].values).toEqual(["tok", "email_verification"])
  })

  it("collapses missing/expired/used/wrong-type into one invalid-token error", async () => {
    const db = new FakeDb()
    db.on("UPDATE tokens SET is_used = TRUE", { rows: [] })
    expect(await consumeToken(db.client, "tok", "password_reset")).toMatchObject({
      error: true,
      message: "Invalid, expired, or already-used token.",
    })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on("UPDATE tokens SET is_used = TRUE", pgError("08006", "connection lost"))
    const result = await consumeToken(db.client, "tok", "email_verification")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while consuming token.",
    })
  })
})

describe("deleteToken", () => {
  it("returns the number of rows deleted", async () => {
    const db = new FakeDb()
    db.on("DELETE FROM tokens", { rowCount: 1 })
    expect(await deleteToken(db.client, "u1", "tok")).toEqual({
      success: true,
      rowCount: 1,
    })
    expect(db.calls[0].values).toEqual(["u1", "tok"])
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on("DELETE FROM tokens", pgError("08006", "connection lost"))
    const result = await deleteToken(db.client, "u1", "tok")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while deleting tokens.",
    })
  })
})

describe("typed token creators", () => {
  const cases: Array<{
    name: string
    fn: (db: DbClient, u: string) => Promise<unknown>
    type: string
    hours: number
  }> = [
    { name: "createEmailToken", fn: (d, u) => createEmailToken(d, u, "a@b.test"), type: "email_verification", hours: 24 }, // prettier-ignore
    { name: "createPasswordToken", fn: (d, u) => createPasswordToken(d, u, "a@b.test"), type: "password_reset", hours: 24 }, // prettier-ignore
    { name: "createLoginToken", fn: createLoginToken, type: "totp_verification_pending", hours: 0.25 }, // prettier-ignore
    { name: "createPasswordUpgradeToken", fn: createPasswordUpgradeToken, type: "password_upgrade", hours: 0.25 }, // prettier-ignore
    { name: "createBypassToken", fn: createBypassToken, type: "totp_bypass", hours: 1 }, // prettier-ignore
    { name: "createSudoToken", fn: createSudoToken, type: "sudo_elevation", hours: 0.25 }, // prettier-ignore
  ]

  for (const { name, fn, type, hours } of cases) {
    it(`${name} issues a '${type}' token expiring in ~${hours}h`, async () => {
      const db = new FakeDb()
      db.on("INSERT INTO tokens", { rows: [{ token_value: "x" }] })
      await fn(db.client, "user-1")
      expect(db.calls[0].values[1]).toBe(type)
      expect(hoursUntil(db.calls[0].values[3])).toBeCloseTo(hours, 1)
    })
  }
})

describe("createWebAuthnToken", () => {
  it("stores the supplied challenge as the token value", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", { rows: [{ token_value: "challenge-bytes" }] })
    const result = await createWebAuthnToken(
      db.client,
      "user-1",
      "webauthn_registration_challenge",
      "challenge-bytes",
      "2099-01-01T00:00:00.000Z"
    )
    expect(result).toMatchObject({
      success: true,
      token_value: "challenge-bytes",
    })
    // token_value is the challenge, not a generated UUID.
    expect(db.calls[0].values[2]).toBe("challenge-bytes")
  })

  it("returns an error envelope when the insert affects no rows", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", { rows: [] })
    expect(await createWebAuthnToken(db.client, "u", "webauthn_authentication_challenge", "c", "2099-01-01")).toMatchObject({ error: true })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on("INSERT INTO tokens", pgError("08006", "connection lost"))
    const result = await createWebAuthnToken(db.client, "user-1", "webauthn_registration_challenge", "c", "2099-01-01")
    expect(result).toMatchObject({
      error: true,
      message: "Server error while creating WebAuthn token.",
    })
  })
})
