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
  org_slug: "acme",
  org_active: true,
  org_created_at: new Date(),
  org_created_by: "user-1",
  ...over,
})

describe("createOrganisation", () => {
  it("rejects an empty name with 400 before any query", async () => {
    const db = new FakeDb()
    expect(
      await createOrganisation(db.client, "  ", "acme", "user-1")
    ).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("rejects a slug that is not URL-safe with 400", async () => {
    const db = new FakeDb()
    expect(
      await createOrganisation(db.client, "Acme", "Not A Slug", "user-1")
    ).toMatchObject({ success: false, status: 400 })
  })

  it("creates the organisation and makes the creator its owner", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisations/, { rows: [orgRow()] })
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    const result = await createOrganisation(db.client, "Acme", "acme", "user-1")
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

  it("rejects a duplicate slug with 409", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisations/, { rows: [] })
    const result = await createOrganisation(db.client, "Acme", "acme", "user-1")
    expect(result).toMatchObject({ success: false, status: 409 })
    // The rollback means no membership row was written.
    expect(
      db.calls.some((c) => c.text.includes("INSERT INTO organisation_members"))
    ).toBe(false)
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
  it("updates the name and slug", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations/, { rows: [orgRow({ org_name: "Acme Inc" })] })
    expect(
      await updateOrganisation(db.client, "org-1", "Acme Inc", "acme")
    ).toMatchObject({ success: true, status: 200 })
  })

  it("returns 404 when the organisation does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations/, { rowCount: 0, rows: [] })
    expect(
      (await updateOrganisation(db.client, "org-1", "Acme", "acme")).status
    ).toBe(404)
  })

  it("maps a slug collision to 409", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisations/, pgError("23505"))
    expect(
      (await updateOrganisation(db.client, "org-1", "Acme", "taken")).status
    ).toBe(409)
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
  it("succeeds when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM organisations/, { rows: [{ org_uuid: "org-1" }] })
    expect(await deleteOrganisation(db.client, "org-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the organisation does not exist", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM organisations/, { rows: [] })
    expect((await deleteOrganisation(db.client, "org-1")).status).toBe(404)
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
