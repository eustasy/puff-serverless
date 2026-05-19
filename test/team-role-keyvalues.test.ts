import { describe, it, expect } from "vitest"
import { readKeyValue, setKeyValue } from "../src/team-role-keyvalues.js"
import { FakeDb } from "./helpers/fake-db.js"

const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("team-role-keyvalues", () => {
  it("rejects unknown team roles with 400", async () => {
    const db = new FakeDb()
    expect(
      (await readKeyValue(db.client, "team-1", "admin", orgOwner, "k")).status
    ).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("accepts known team roles (lead/member)", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM team_role_key_values/, {
      rows: [{ kv_value: "v" }],
    })
    expect(
      (await readKeyValue(db.client, "team-1", "lead", orgOwner, "k")).success
    ).toBe(true)
    expect(db.calls[0].values).toEqual(["team-1", "lead", "org-1", "k"])
  })

  it("setKeyValue carries (team_uuid, role) into the INSERT", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM team_role_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO team_role_key_values/, { rowCount: 1 })
    await setKeyValue(
      db.client,
      "team-1",
      "lead",
      orgOwner,
      "max_concurrent",
      "10"
    )
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    expect(insert.values).toEqual([
      "team-1",
      "lead",
      "max_concurrent",
      "10",
      null,
      "org-1",
    ])
  })
})
