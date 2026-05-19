import { describe, it, expect } from "vitest"
import {
  createTeam,
  readTeam,
  updateTeam,
  deleteTeam,
  listTeams,
} from "../src/teams.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const teamRow = (over: Partial<TeamRow> = {}): TeamRow => ({
  team_uuid: "team-1",
  org_uuid: "org-1",
  team_name: "Platform",
  team_slug: "platform",
  team_created_at: new Date(),
  ...over,
})

describe("createTeam", () => {
  it("rejects an empty name with 400 before any query", async () => {
    const db = new FakeDb()
    expect(await createTeam(db.client, "org-1", "", "platform")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(0)
  })

  it("creates a team", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO teams/, { rows: [teamRow()] })
    const result = await createTeam(db.client, "org-1", "Platform", "platform")
    expect(result).toMatchObject({ success: true, status: 201 })
  })

  it("rejects a slug already used in the organisation with 409", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO teams/, { rows: [] })
    expect(
      (await createTeam(db.client, "org-1", "Platform", "platform")).status
    ).toBe(409)
  })

  it("maps a missing organisation (FK violation) to 404", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO teams/, pgError("23503"))
    expect(
      (await createTeam(db.client, "ghost-org", "Platform", "platform")).status
    ).toBe(404)
  })
})

describe("readTeam", () => {
  it("returns the team when found", async () => {
    const db = new FakeDb()
    const row = teamRow()
    db.on(/SELECT .* FROM teams/, { rows: [row] })
    expect(await readTeam(db.client, "team-1")).toEqual({
      success: true,
      team: row,
      status: 200,
    })
  })

  it("returns 404 when not found", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM teams/, { rows: [] })
    expect((await readTeam(db.client, "team-1")).status).toBe(404)
  })
})

describe("updateTeam", () => {
  it("updates the name and slug", async () => {
    const db = new FakeDb()
    db.on(/UPDATE teams/, { rows: [teamRow({ team_name: "Core" })] })
    expect(await updateTeam(db.client, "team-1", "Core", "core")).toMatchObject(
      { success: true, status: 200 }
    )
  })

  it("returns 404 when the team does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE teams/, { rowCount: 0, rows: [] })
    expect((await updateTeam(db.client, "team-1", "Core", "core")).status).toBe(
      404
    )
  })

  it("maps a slug collision to 409", async () => {
    const db = new FakeDb()
    db.on(/UPDATE teams/, pgError("23505"))
    expect(
      (await updateTeam(db.client, "team-1", "Core", "taken")).status
    ).toBe(409)
  })
})

describe("deleteTeam", () => {
  it("succeeds when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM teams/, { rows: [{ team_uuid: "team-1" }] })
    expect(await deleteTeam(db.client, "team-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the team does not exist", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM teams/, { rows: [] })
    expect((await deleteTeam(db.client, "team-1")).status).toBe(404)
  })
})

describe("listTeams", () => {
  it("returns every team in the organisation", async () => {
    const db = new FakeDb()
    const rows = [
      teamRow(),
      teamRow({ team_uuid: "team-2", team_slug: "core" }),
    ]
    db.on(/FROM teams WHERE org_uuid/, { rows })
    expect(await listTeams(db.client, "org-1")).toEqual({
      success: true,
      teams: rows,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM teams WHERE org_uuid/, pgError("08006"))
    expect((await listTeams(db.client, "org-1")).status).toBe(500)
  })
})
