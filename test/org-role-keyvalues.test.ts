import { describe, it, expect } from "vitest"
import { readKeyValue, readKeyValues, searchKeyValues, setKeyValue, deleteKeyValue } from "../src/org-role-keyvalues.js"
import { FakeDb } from "./helpers/fake-db.js"

const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("org-role-keyvalues", () => {
  it("rejects unknown roles with 400 before any query", async () => {
    const db = new FakeDb()
    expect((await readKeyValue(db.client, "org-1", "ceo", orgOwner, "k")).status).toBe(400)
    expect(db.calls).toHaveLength(0)

    expect((await setKeyValue(db.client, "org-1", "ceo", orgOwner, "k", "v")).status).toBe(400)

    expect((await deleteKeyValue(db.client, "org-1", "ceo", orgOwner, "k")).status).toBe(400)
  })

  it("accepts known org roles (owner/admin/member/billing)", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM org_role_key_values/, {
      rows: [{ kv_value: "v" }],
    })
    expect((await readKeyValue(db.client, "org-1", "admin", orgOwner, "k")).success).toBe(true)
    expect(db.calls[0].values).toEqual(["org-1", "admin", "org-1", "k"])
  })

  it("setKeyValue carries (org_uuid, role) into the INSERT", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM org_role_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO org_role_key_values/, { rowCount: 1 })
    await setKeyValue(db.client, "org-1", "billing", orgOwner, "monthly_cap", "5000")
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    expect(insert.values).toEqual(["org-1", "billing", "monthly_cap", "5000", null, "org-1", null])
  })

  it("readKeyValues rejects an invalid role without querying", async () => {
    const db = new FakeDb()
    const result = await readKeyValues(db.client, "org-1", "ceo", orgOwner)
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("readKeyValues returns all rows for a valid role", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM org_role_key_values/, { rows: [{ kv_key: "cap", kv_value: "5000" }] })
    const result = await readKeyValues(db.client, "org-1", "admin", orgOwner)
    expect(result).toMatchObject({ success: true, pairs: [{ kv_key: "cap" }] })
  })

  it("searchKeyValues rejects an invalid role without querying", async () => {
    const db = new FakeDb()
    const result = await searchKeyValues(db.client, "org-1", "ceo", orgOwner, "cap")
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("searchKeyValues returns matching rows for a valid role and non-empty pattern", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM org_role_key_values/, { rows: [{ kv_key: "cap_limit", kv_value: "100" }] })
    const result = await searchKeyValues(db.client, "org-1", "admin", orgOwner, "cap")
    expect(result).toMatchObject({ success: true, pairs: [{ kv_key: "cap_limit" }] })
  })
})
