import { describe, it, expect } from "vitest"
import { readKeyValue, setKeyValue } from "../src/organisation-keyvalues.js"
import { FakeDb } from "./helpers/fake-db.js"

const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("organisation-keyvalues", () => {
  it("readKeyValue queries organisation_key_values by org_uuid + owner", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM organisation_key_values/, {
      rows: [{ kv_value: "v" }],
    })
    await readKeyValue(db.client, "org-1", orgOwner, "billing_plan")
    expect(db.calls[0].text).toContain("WHERE org_uuid = $1")
    expect(db.calls[0].values).toEqual(["org-1", "org-1", "billing_plan"])
  })

  it("setKeyValue inserts with the org-org owner combination", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM organisation_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO organisation_key_values/, { rowCount: 1 })
    await setKeyValue(db.client, "org-1", orgOwner, "billing_plan", "pro")
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    // org-owned data attached to org itself
    expect(insert.values).toEqual(["org-1", "billing_plan", "pro", null, "org-1", null])
  })
})
