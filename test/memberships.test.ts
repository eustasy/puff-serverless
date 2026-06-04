import { describe, it, expect } from "vitest"
import {
  addOrgMember,
  removeOrgMember,
  setOrgMemberRoles,
  listOrgMembers,
  addTeamMember,
  removeTeamMember,
  setTeamMemberRoles,
  listTeamMembers,
  getOrgRoles,
  getTeamRoles,
} from "../src/memberships.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

// The owner-count guard query in removeOrgMember / setOrgMemberRoles.
const COUNT_QUERY = /count\(\*\) FILTER/

describe("addOrgMember", () => {
  it("rejects an unknown role with 400 before any query", async () => {
    const db = new FakeDb()
    expect(await addOrgMember(db.client, "org-1", "user-1", "superuser", "user-9")).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("returns 201 when the role is newly granted", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    expect(await addOrgMember(db.client, "org-1", "user-1", "admin", "user-9")).toEqual({ success: true, status: 201 })
  })

  it("is idempotent — returns 200 when the role was already held", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisation_members/, { rowCount: 0 })
    expect(await addOrgMember(db.client, "org-1", "user-1", "admin", "user-9")).toEqual({ success: true, status: 200 })
  })

  it("maps a foreign-key violation to 404", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisation_members/, pgError("23503"))
    expect((await addOrgMember(db.client, "ghost", "user-1", "admin", null)).status).toBe(404)
  })
})

describe("removeOrgMember", () => {
  it("removes a member who is not the last owner", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, {
      rows: [{ owners: 2, target_owner: 1, target_rows: 1 }],
    })
    db.on(/DELETE FROM organisation_members/, { rowCount: 1 })
    expect(await removeOrgMember(db.client, "org-1", "user-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the user is not a member", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, {
      rows: [{ owners: 1, target_owner: 0, target_rows: 0 }],
    })
    expect((await removeOrgMember(db.client, "org-1", "user-1")).status).toBe(404)
  })

  it("refuses to remove the organisation's last owner with 409", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, {
      rows: [{ owners: 1, target_owner: 1, target_rows: 1 }],
    })
    const result = await removeOrgMember(db.client, "org-1", "user-1")
    expect(result).toMatchObject({ success: false, status: 409 })
    expect(db.calls.some((c) => c.text.includes("DELETE FROM organisation_members"))).toBe(false)
  })
})

describe("setOrgMemberRoles", () => {
  it("rejects an empty role set with 400", async () => {
    const db = new FakeDb()
    expect(await setOrgMemberRoles(db.client, "org-1", "user-1", [], "user-9")).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an unknown role with 400", async () => {
    const db = new FakeDb()
    expect(await setOrgMemberRoles(db.client, "org-1", "user-1", ["wizard"], null)).toMatchObject({ success: false, status: 400 })
  })

  it("replaces the role set", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, { rows: [{ owners: 2, target_owner: 0 }] })
    db.on(/DELETE FROM organisation_members/, { rowCount: 1 })
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    expect(await setOrgMemberRoles(db.client, "org-1", "user-1", ["admin", "billing"], "user-9")).toEqual({ success: true, status: 200 })
  })

  it("refuses to demote the organisation's last owner with 409", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, { rows: [{ owners: 1, target_owner: 1 }] })
    const result = await setOrgMemberRoles(db.client, "org-1", "user-1", ["admin"], "user-9")
    expect(result).toMatchObject({ success: false, status: 409 })
  })

  it("allows the last owner to keep the owner role alongside others", async () => {
    const db = new FakeDb()
    db.on(COUNT_QUERY, { rows: [{ owners: 1, target_owner: 1 }] })
    db.on(/DELETE FROM organisation_members/, { rowCount: 1 })
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    expect(await setOrgMemberRoles(db.client, "org-1", "user-1", ["owner", "billing"], "user-9")).toEqual({ success: true, status: 200 })
  })
})

describe("listOrgMembers", () => {
  it("returns members with their roles", async () => {
    const db = new FakeDb()
    const members = [
      {
        user_uuid: "user-1",
        user_name: "alice",
        roles: ["owner"],
        joined_at: new Date(),
      },
    ]
    db.on(/FROM organisation_members m/, { rows: members })
    expect(await listOrgMembers(db.client, "org-1")).toEqual({
      success: true,
      members,
      status: 200,
    })
  })
})

describe("addTeamMember", () => {
  it("rejects an unknown team role with 400", async () => {
    const db = new FakeDb()
    expect(await addTeamMember(db.client, "team-1", "user-1", "owner", null)).toMatchObject({ success: false, status: 400 })
  })

  it("returns 201 when the role is newly granted", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO team_members/, { rowCount: 1 })
    expect(await addTeamMember(db.client, "team-1", "user-1", "lead", "user-9")).toEqual({ success: true, status: 201 })
  })

  it("maps a foreign-key violation to 404", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO team_members/, pgError("23503"))
    expect((await addTeamMember(db.client, "ghost", "user-1", "lead", null)).status).toBe(404)
  })
})

describe("removeTeamMember", () => {
  it("removes a team member", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM team_members/, { rowCount: 1 })
    expect(await removeTeamMember(db.client, "team-1", "user-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the user is not a team member", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM team_members/, { rowCount: 0 })
    expect((await removeTeamMember(db.client, "team-1", "user-1")).status).toBe(404)
  })
})

describe("setTeamMemberRoles", () => {
  it("rejects an empty role set with 400", async () => {
    const db = new FakeDb()
    expect(await setTeamMemberRoles(db.client, "team-1", "user-1", [], null)).toMatchObject({ success: false, status: 400 })
  })

  it("replaces the team role set", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM team_members/, { rowCount: 1 })
    db.on(/INSERT INTO team_members/, { rowCount: 1 })
    expect(await setTeamMemberRoles(db.client, "team-1", "user-1", ["lead"], "user-9")).toEqual({ success: true, status: 200 })
  })
})

describe("listTeamMembers", () => {
  it("returns members with their roles", async () => {
    const db = new FakeDb()
    const members = [
      {
        user_uuid: "user-1",
        user_name: "bob",
        roles: ["lead"],
        joined_at: new Date(),
      },
    ]
    db.on(/FROM team_members m/, { rows: members })
    expect(await listTeamMembers(db.client, "team-1")).toMatchObject({
      success: true,
      members,
    })
  })
})

describe("getOrgRoles / getTeamRoles", () => {
  it("returns every organisation role a user holds", async () => {
    const db = new FakeDb()
    db.on(/SELECT role FROM organisation_members/, {
      rows: [{ role: "owner" }, { role: "billing" }],
    })
    expect(await getOrgRoles(db.client, "org-1", "user-1")).toEqual({
      success: true,
      roles: ["owner", "billing"],
      status: 200,
    })
  })

  it("returns an empty array when the user holds no organisation role", async () => {
    const db = new FakeDb()
    db.on(/SELECT role FROM organisation_members/, { rows: [] })
    expect(await getOrgRoles(db.client, "org-1", "user-1")).toMatchObject({
      roles: [],
    })
  })

  it("returns every team role a user holds", async () => {
    const db = new FakeDb()
    db.on(/SELECT role FROM team_members/, { rows: [{ role: "lead" }] })
    expect(await getTeamRoles(db.client, "team-1", "user-1")).toEqual({
      success: true,
      roles: ["lead"],
      status: 200,
    })
  })
})
