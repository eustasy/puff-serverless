import { describe, it, expect } from "vitest"
import {
  listPasskeys,
  getPasskeyByCredentialId,
  savePasskey,
  updatePasskeyCounter,
  deletePasskey,
  getRpConfig,
} from "../src/passkeys.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"
import { fakeEnv } from "./helpers/fake-env.js"

describe("listPasskeys", () => {
  it("returns the user's enabled passkeys", async () => {
    const db = new FakeDb()
    const rows = [{ passkey_uuid: "p1" }, { passkey_uuid: "p2" }]
    db.on(/FROM passkeys/, { rows })
    expect(await listPasskeys(db.client, "user-1")).toEqual({
      success: true,
      passkeys: rows,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM passkeys/, pgError("08006"))
    expect((await listPasskeys(db.client, "user-1")).status).toBe(500)
  })
})

describe("getPasskeyByCredentialId", () => {
  it("returns the passkey when found", async () => {
    const db = new FakeDb()
    const row = { passkey_uuid: "p1", credential_id: "cred" }
    db.on(/FROM passkeys/, { rows: [row] })
    expect(await getPasskeyByCredentialId(db.client, "cred")).toMatchObject({
      success: true,
      passkey: row,
    })
  })

  it("returns 404 when the credential is unknown", async () => {
    const db = new FakeDb()
    db.on(/FROM passkeys/, { rows: [] })
    expect((await getPasskeyByCredentialId(db.client, "cred")).status).toBe(404)
  })
})

describe("savePasskey", () => {
  it("inserts the passkey, base64url-encoding the public key, and returns 201", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO passkeys/, { rowCount: 1 })
    const result = await savePasskey(
      db.client,
      "user-1",
      "cred-id",
      new Uint8Array([1, 2, 3, 250]),
      0,
      ["internal"],
      "My Laptop"
    )
    expect(result).toMatchObject({ success: true, status: 201 })
    expect(db.calls[0].values[2]).toBe("cred-id")
    // Public key is stored base64url-encoded (no +, /, or = padding).
    expect(db.calls[0].values[3]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(db.calls[0].values[5]).toEqual(["internal"])
  })

  it("stores null when no transports are supplied", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO passkeys/, { rowCount: 1 })
    await savePasskey(db.client, "user-1", "c", new Uint8Array([1]), 0, undefined, "k") // prettier-ignore
    expect(db.calls[0].values[5]).toBeNull()
  })
})

describe("updatePasskeyCounter", () => {
  it("updates the counter and returns 200", async () => {
    const db = new FakeDb()
    db.on(/UPDATE passkeys/, { rowCount: 1 })
    expect(await updatePasskeyCounter(db.client, "p1", 42)).toMatchObject({
      success: true,
      status: 200,
    })
    expect(db.calls[0].values).toEqual([42, "p1"])
  })

  it("returns 500 when the update throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE passkeys/, pgError("08006"))
    expect((await updatePasskeyCounter(db.client, "p1", 1)).status).toBe(500)
  })
})

describe("deletePasskey", () => {
  it("succeeds when a passkey owned by the user was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM passkeys/, { rowCount: 1 })
    expect(await deletePasskey(db.client, "p1", "user-1")).toMatchObject({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when no matching passkey exists", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM passkeys/, { rowCount: 0 })
    expect((await deletePasskey(db.client, "p1", "user-1")).status).toBe(404)
  })
})

describe("getRpConfig", () => {
  it("uses an explicit WEBAUTHN_RP_ID when set", () => {
    expect(
      getRpConfig(fakeEnv({ WEBAUTHN_RP_ID: "auth.example.com" }))
    ).toMatchObject({ rpID: "auth.example.com" })
  })

  it("derives the RP ID from APP_URL's hostname", () => {
    expect(
      getRpConfig(fakeEnv({ APP_URL: "https://app.example.com/login" })).rpID
    ).toBe("app.example.com")
  })

  it("falls back to localhost when nothing is configured", () => {
    expect(getRpConfig(fakeEnv()).rpID).toBe("localhost")
  })

  it("resolves the RP name from WEBAUTHN_RP_NAME, then APP_NAME, then a default", () => {
    expect(getRpConfig(fakeEnv({ WEBAUTHN_RP_NAME: "Auth" })).rpName).toBe(
      "Auth"
    )
    expect(getRpConfig(fakeEnv({ APP_NAME: "Puff" })).rpName).toBe("Puff")
    expect(getRpConfig(fakeEnv()).rpName).toBe("puff")
  })
})
