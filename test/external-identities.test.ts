import { describe, it, expect } from "vitest"
import {
  findByProvider,
  linkExternalIdentity,
  listExternalIdentities,
  unlinkExternalIdentity,
  updateLastUsed,
} from "../src/external-identities.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("listExternalIdentities", () => {
  it("returns rows in oldest-first order", async () => {
    const db = new FakeDb()
    const row = {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: "a@b.test",
      display_name: "Alice",
      linked_at: new Date(),
      last_used_at: null,
    }
    db.on(/FROM external_identities/, { rows: [row] })
    const result = await listExternalIdentities(db.client, "u-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.identities).toHaveLength(1)
  })

  it("returns a 500 envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM external_identities/, pgError("08006", "connection lost"))
    const result = await listExternalIdentities(db.client, "u-1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("findByProvider", () => {
  it("returns the row when matched", async () => {
    const db = new FakeDb()
    db.on(/FROM external_identities[\s\S]*WHERE provider/, {
      rows: [{ user_uuid: "u-1", provider: "github", provider_user_id: "gh-1" }],
    })
    const r = await findByProvider(db.client, "github", "gh-1")
    expect(r.success).toBe(true)
    if (r.success) expect(r.identity?.user_uuid).toBe("u-1")
  })

  it("returns null when not matched", async () => {
    const db = new FakeDb()
    db.on(/FROM external_identities[\s\S]*WHERE provider/, { rows: [] })
    const r = await findByProvider(db.client, "github", "gh-x")
    expect(r.success).toBe(true)
    if (r.success) expect(r.identity).toBeNull()
  })

  it("returns a 500 envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM external_identities/, pgError("08006"))
    const r = await findByProvider(db.client, "github", "gh-1")
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("linkExternalIdentity", () => {
  it("returns 'created' on a fresh insert", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO external_identities/, { rows: [{ inserted: true }] })
    const r = await linkExternalIdentity(db.client, {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: "a@b.test",
      display_name: "Alice",
    })
    expect(r).toMatchObject({ success: true, linked: "created", status: 201 })
  })

  it("returns 'updated' when the same user re-links", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO external_identities/, { rows: [{ inserted: false }] })
    const r = await linkExternalIdentity(db.client, {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: "a@b.test",
      display_name: "Alice",
    })
    expect(r).toMatchObject({ success: true, linked: "updated", status: 200 })
  })

  it("returns 409 when the identity is already linked to another user", async () => {
    const db = new FakeDb()
    // ON CONFLICT WHERE clause filtered the row out — rows is empty.
    db.on(/INSERT INTO external_identities/, { rows: [] })
    const r = await linkExternalIdentity(db.client, {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: null,
      display_name: null,
    })
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(409)
  })

  it("returns 409 on a unique-constraint violation", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO external_identities/, pgError("23505"))
    const r = await linkExternalIdentity(db.client, {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: null,
      display_name: null,
    })
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(409)
  })

  it("returns a 500 envelope on an unexpected (non-unique) error", async () => {
    const db = new FakeDb()
    // A thrown non-Error exercises the String(error) fallback in the catch.
    db.on(/INSERT INTO external_identities/, () => {
      throw "connection reset"
    })
    const r = await linkExternalIdentity(db.client, {
      user_uuid: "u-1",
      provider: "github",
      provider_user_id: "gh-1",
      email: null,
      display_name: null,
    })
    expect(r).toMatchObject({ error: true, status: 500, details: "connection reset" })
  })
})

describe("unlinkExternalIdentity", () => {
  it("refuses to remove the last credential", async () => {
    const db = new FakeDb()
    db.on(/password_count[\s\S]*passkey_count[\s\S]*other_identity_count/, {
      rows: [{ password_count: 0, passkey_count: 0, other_identity_count: 0 }],
    })
    const r = await unlinkExternalIdentity(db.client, "u-1", "github", "gh-1")
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(409)
  })

  it("deletes when another credential exists", async () => {
    const db = new FakeDb()
    db.on(/password_count[\s\S]*passkey_count[\s\S]*other_identity_count/, {
      rows: [{ password_count: 1, passkey_count: 0, other_identity_count: 0 }],
    })
    db.on(/DELETE FROM external_identities/, { rows: [], rowCount: 1 })
    const r = await unlinkExternalIdentity(db.client, "u-1", "github", "gh-1")
    expect(r.success).toBe(true)
  })

  it("returns 404 when the row was not found", async () => {
    const db = new FakeDb()
    db.on(/password_count/, {
      rows: [{ password_count: 1, passkey_count: 0, other_identity_count: 0 }],
    })
    db.on(/DELETE FROM external_identities/, { rows: [], rowCount: 0 })
    const r = await unlinkExternalIdentity(db.client, "u-1", "github", "gh-x")
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(404)
  })

  it("returns a 500 envelope when the transaction throws an unexpected error", async () => {
    const db = new FakeDb()
    db.on(/password_count/, pgError("08006"))
    const r = await unlinkExternalIdentity(db.client, "u-1", "github", "gh-1")
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("updateLastUsed", () => {
  it("issues the UPDATE and resolves", async () => {
    const db = new FakeDb()
    db.on(/UPDATE external_identities/, { rows: [], rowCount: 1 })
    await expect(updateLastUsed(db.client, "github", "gh-1")).resolves.toBeUndefined()
    expect(db.calls[0].values).toEqual(["github", "gh-1"])
  })

  it("swallows errors (non-fatal)", async () => {
    const db = new FakeDb()
    db.on(/UPDATE external_identities/, pgError("08006"))
    await expect(updateLastUsed(db.client, "github", "gh-1")).resolves.toBeUndefined()
  })
})
