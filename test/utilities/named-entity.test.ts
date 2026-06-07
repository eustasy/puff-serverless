import { describe, it, expect } from "vitest"
import { readNamedEntity, updateNamedEntityName, type NamedEntitySpec } from "../../src/utilities/named-entity.js"
import { FakeDb, pgError } from "../helpers/fake-db.js"

const spec: NamedEntitySpec = {
  table: "orgs",
  columns: "org_uuid, org_name",
  idColumn: "org_uuid",
  nameColumn: "org_name",
  noun: "organisation",
  validateName: (name) => (name.trim().length === 0 ? "A name is required." : null),
}

describe("readNamedEntity", () => {
  it("returns the row when found", async () => {
    const db = new FakeDb()
    db.on(/FROM orgs/, { rows: [{ org_uuid: "o-1", org_name: "Acme" }] })
    const result = await readNamedEntity(db.client, spec, "o-1")
    expect(result).toMatchObject({ success: true, row: { org_uuid: "o-1" } })
    expect(db.calls[0].values).toEqual(["o-1"])
  })

  it("returns 404 when no row matches", async () => {
    const db = new FakeDb()
    db.on(/FROM orgs/, { rows: [] })
    const result = await readNamedEntity(db.client, spec, "missing")
    expect(result).toMatchObject({ success: false, status: 404 })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM orgs/, pgError("08006", "connection lost"))
    const result = await readNamedEntity(db.client, spec, "o-1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("updateNamedEntityName", () => {
  it("returns 400 on an invalid name without querying", async () => {
    const db = new FakeDb()
    const result = await updateNamedEntityName(db.client, spec, "o-1", "   ")
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("updates the name when valid and returns the updated row", async () => {
    const db = new FakeDb()
    db.on(/UPDATE orgs/, { rowCount: 1, rows: [{ org_uuid: "o-1", org_name: "New Name" }] })
    const result = await updateNamedEntityName(db.client, spec, "o-1", "New Name")
    expect(result).toMatchObject({ success: true, row: { org_name: "New Name" } })
  })

  it("returns 404 when no row matched the UPDATE", async () => {
    const db = new FakeDb()
    db.on(/UPDATE orgs/, { rowCount: 0, rows: [] })
    const result = await updateNamedEntityName(db.client, spec, "o-99", "New Name")
    expect(result).toMatchObject({ success: false, status: 404 })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE orgs/, pgError("08006", "connection lost"))
    const result = await updateNamedEntityName(db.client, spec, "o-1", "New Name")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})
