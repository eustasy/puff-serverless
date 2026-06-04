import { describe, it, expect } from "vitest"
import { create2fa, read2fa, delete2fa, has2fa, enable2fa, used2fa } from "../src/2fa.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

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
