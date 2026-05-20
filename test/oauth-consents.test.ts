import { describe, it, expect } from "vitest"
import {
  hasConsentFor,
  readConsent,
  revokeConsent,
  upsertConsent,
} from "../src/oauth-consents.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("readConsent", () => {
  it("returns exists:true with the stored consent row", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, {
      rows: [
        {
          user_uuid: "u-1",
          app_uuid: "a-1",
          scopes: ["openid", "email"],
          granted_at: new Date(),
        },
      ],
    })
    const result = await readConsent(db.client, "u-1", "a-1")
    expect(result.success).toBe(true)
    if (result.success && "exists" in result && result.exists) {
      expect(result.consent.scopes).toEqual(["openid", "email"])
    }
  })

  it("returns exists:false when no row matches", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, { rows: [] })
    const result = await readConsent(db.client, "u-1", "a-1")
    expect(result.success).toBe(true)
    if (result.success && "exists" in result) expect(result.exists).toBe(false)
  })

  it("returns 500 on DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, pgError("08006"))
    expect((await readConsent(db.client, "u-1", "a-1")).status).toBe(500)
  })
})

describe("upsertConsent", () => {
  it("uses INSERT ... ON CONFLICT ... DO UPDATE to replace scopes", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_consents/, {
      rows: [
        {
          user_uuid: "u-1",
          app_uuid: "a-1",
          scopes: ["openid", "email"],
          granted_at: new Date(),
        },
      ],
    })
    const result = await upsertConsent(db.client, "u-1", "a-1", [
      "openid",
      "email",
    ])
    expect(result.success).toBe(true)
    expect(db.calls[0]!.text).toMatch(/ON CONFLICT \(user_uuid, app_uuid\)/)
    expect(db.calls[0]!.values).toEqual(["u-1", "a-1", ["openid", "email"]])
  })
})

describe("revokeConsent", () => {
  it("reports revoked:true when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM oauth_consents/, { rows: [{ user_uuid: "u-1" }] })
    const result = await revokeConsent(db.client, "u-1", "a-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.revoked).toBe(true)
  })

  it("reports revoked:false when there was nothing to delete", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM oauth_consents/, { rows: [] })
    const result = await revokeConsent(db.client, "u-1", "a-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.revoked).toBe(false)
  })
})

describe("hasConsentFor", () => {
  it("returns covered:true when stored scopes ⊇ requested", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, {
      rows: [{ scopes: ["openid", "email", "profile"] }],
    })
    const result = await hasConsentFor(db.client, "u-1", "a-1", [
      "openid",
      "email",
    ])
    expect(result.success).toBe(true)
    if (result.success) expect(result.covered).toBe(true)
  })

  it("returns covered:false when a requested scope is missing", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, { rows: [{ scopes: ["openid"] }] })
    const result = await hasConsentFor(db.client, "u-1", "a-1", [
      "openid",
      "email",
    ])
    expect(result.success).toBe(true)
    if (result.success) expect(result.covered).toBe(false)
  })

  it("returns covered:false when there's no consent row at all", async () => {
    const db = new FakeDb()
    db.on(/FROM oauth_consents/, { rows: [] })
    const result = await hasConsentFor(db.client, "u-1", "a-1", ["openid"])
    expect(result.success).toBe(true)
    if (result.success) expect(result.covered).toBe(false)
  })
})
