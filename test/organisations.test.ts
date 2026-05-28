import { describe, it, expect } from "vitest"
import {
  createOrganisation,
  readOrganisation,
  updateOrganisation,
  disableOrganisation,
  enableOrganisation,
  deleteOrganisation,
  listOrganisationsForUser,
} from "../src/organisations.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const orgRow = (over: Partial<OrganisationRow> = {}): OrganisationRow => ({
  org_uuid: "org-1",
  org_name: "Acme",
  org_active: true,
  org_locale: null,
  org_created_at: new Date(),
  org_created_by: "user-1",
  ...over,
})

describe("createOrganisation", () => {
  it("rejects an empty name with 400 before any query", async () => {
    const db = new FakeDb()
    expect(await createOrganisation(db.client, "  ", "user-1")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(0)
  })

  it("creates the organisation and makes the creator its owner", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisations/, { rows: [orgRow()] })
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    const result = await createOrganisation(db.client, "Acme", "user-1")
    expect(result).toMatchObject({ success: true, status: 201 })
    // The membership insert grants the creator the owner role, against the
    // same generated org UUID the organisation row was inserted with.
    const orgInsert = db.calls.find((c) =>
      c.text.includes("INSERT INTO organisations")
    )
    const memberInsert = db.calls.find((c) =>
      c.text.includes("INSERT INTO organisation_members")
    )
    expect(memberInsert?.values[0]).toBe(orgInsert?.values[0])
    expect(memberInsert?.values[1]).toBe("user-1")
    expect(memberInsert?.values[2]).toBe("owner")
  })

  it("returns 500 when the insert throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisations/, pgError("08006"))
    expect((await createOrganisation(db.client, "Acme", "user-1")).status).toBe(
      500
    )
  })
})

describe("readOrganisation", () => {
  it("returns the organisation when found", async () => {
    const db = new FakeDb()
    const row = orgRow()
    db.on(/SELECT .* FROM organisations/, { rows: [row] })
    expect(await readOrganisation(db.client, "org-1")).toEqual({
      success: true,
      organisation: row,
      status: 200,
    })
  })

  it("returns 404 when not found", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM organisations/, { rows: [] })
    expect((await readOrganisation(db.client, "org-1")).status).toBe(404)
  })
})

describe("updateOrganisation", () => {
  it("updates the name", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations/, { rows: [orgRow({ org_name: "Acme Inc" })] })
    expect(
      await updateOrganisation(db.client, "org-1", "Acme Inc")
    ).toMatchObject({ success: true, status: 200 })
  })

  it("rejects an empty name with 400", async () => {
    const db = new FakeDb()
    expect(await updateOrganisation(db.client, "org-1", " ")).toMatchObject({
      success: false,
      status: 400,
    })
  })

  it("returns 404 when the organisation does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations/, { rowCount: 0, rows: [] })
    expect((await updateOrganisation(db.client, "org-1", "Acme")).status).toBe(
      404
    )
  })
})

describe("disableOrganisation / enableOrganisation", () => {
  it("disables an organisation", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations SET org_active/, { rowCount: 1 })
    expect(await disableOrganisation(db.client, "org-1")).toEqual({
      success: true,
      status: 200,
    })
    expect(db.calls[0].values).toEqual(["org-1", false])
  })

  it("enables an organisation", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations SET org_active/, { rowCount: 1 })
    await enableOrganisation(db.client, "org-1")
    expect(db.calls[0].values).toEqual(["org-1", true])
  })

  it("returns 404 when the organisation does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations SET org_active/, { rowCount: 0 })
    expect((await disableOrganisation(db.client, "org-1")).status).toBe(404)
  })
})

describe("deleteOrganisation", () => {
  it("succeeds when a row was deleted and there is no outstanding balance", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices/, { rows: [], rowCount: 0 })
    db.on(/DELETE FROM organisations/, { rows: [{ org_uuid: "org-1" }] })
    expect(await deleteOrganisation(db.client, "org-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the organisation does not exist", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices/, { rows: [], rowCount: 0 })
    db.on(/DELETE FROM organisations/, { rows: [] })
    expect((await deleteOrganisation(db.client, "org-1")).status).toBe(404)
  })

  it("refuses with 409 when the org has an outstanding balance", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices/, { rows: [{ "?column?": 1 }], rowCount: 1 })
    const result = await deleteOrganisation(db.client, "org-1")
    expect(result).toMatchObject({ success: false, status: 409 })
    // The DELETE must not have run.
    expect(db.calls.some((c) => /DELETE FROM organisations/.test(c.text))).toBe(
      false
    )
  })
})

describe("listOrganisationsForUser", () => {
  it("returns the user's organisations with their roles", async () => {
    const db = new FakeDb()
    const rows = [{ ...orgRow(), roles: ["owner"] }]
    db.on(/FROM organisations o/, { rows })
    expect(await listOrganisationsForUser(db.client, "user-1")).toEqual({
      success: true,
      organisations: rows,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM organisations o/, pgError("08006"))
    expect((await listOrganisationsForUser(db.client, "user-1")).status).toBe(
      500
    )
  })
})
