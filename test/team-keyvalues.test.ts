import { describe, it, expect } from "vitest"
import {
  readKeyValue,
  readKeyValues,
  setKeyValue,
  deleteKeyValue,
} from "../src/team-keyvalues.js"
import { FakeDb } from "./helpers/fake-db.js"

const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("team-keyvalues", () => {
  it("readKeyValue returns the value when the row exists", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM team_key_values/, {
      rows: [{ kv_value: "blue" }],
    })
    expect(await readKeyValue(db.client, "team-1", orgOwner, "colour")).toEqual(
      { success: true, value: "blue", status: 200 }
    )
    expect(db.calls[0].values).toEqual(["team-1", "org-1", "colour"])
  })

  it("readKeyValues queries by team_uuid + owner", async () => {
    const db = new FakeDb()
    db.on(/FROM team_key_values/, { rows: [] })
    await readKeyValues(db.client, "team-1", orgOwner)
    expect(db.calls[0].text).toContain("WHERE team_uuid = $1")
    expect(db.calls[0].text).toContain("owner_org_uuid = $2")
  })

  it("setKeyValue upserts via the shared INSERT path", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM team_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO team_key_values/, { rowCount: 1 })
    const result = await setKeyValue(
      db.client,
      "team-1",
      orgOwner,
      "default_quota",
      "100"
    )
    expect(result).toMatchObject({ success: true, created: true })
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    expect(insert.values).toEqual([
      "team-1",
      "default_quota",
      "100",
      null,
      "org-1",
      null,
    ])
  })

  it("deleteKeyValue returns 404 when the row is absent", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM team_key_values/, { rowCount: 0 })
    expect(
      (await deleteKeyValue(db.client, "team-1", orgOwner, "k")).status
    ).toBe(404)
  })
})
