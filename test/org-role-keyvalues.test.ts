import { describe, it, expect } from "vitest"
import { readKeyValue, setKeyValue, deleteKeyValue } from "../src/org-role-keyvalues.js"
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
})
