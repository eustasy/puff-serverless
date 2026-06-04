import { describe, it, expect } from "vitest"
import { createInvitation, readInvitation, acceptInvitation, listInvitations, revokeInvitation } from "../src/invitations.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const invitationRow = (over: Partial<OrganisationInvitationRow> = {}): OrganisationInvitationRow => ({
  invitation_token: "tok-1",
  org_uuid: "org-1",
  email_address: "invitee@example.com",
  roles: ["member"],
  invited_by: "user-9",
  created_at: new Date(),
  expires_at: new Date(Date.now() + 60_000),
  is_used: false,
  ...over,
})

describe("createInvitation", () => {
  it("rejects an empty email with 400 before any query", async () => {
    const db = new FakeDb()
    expect(await createInvitation(db.client, "org-1", "  ", ["member"], "user-9")).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an empty or unknown role set with 400", async () => {
    const db = new FakeDb()
    expect(await createInvitation(db.client, "org-1", "a@b.test", [], "user-9")).toMatchObject({ success: false, status: 400 })
    expect(await createInvitation(db.client, "org-1", "a@b.test", ["wizard"], null)).toMatchObject({ success: false, status: 400 })
  })

  it("creates an invitation", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisation_invitations/, { rows: [invitationRow()] })
    const result = await createInvitation(db.client, "org-1", "invitee@example.com", ["member", "billing"], "user-9")
    expect(result).toMatchObject({ success: true, status: 201 })
  })

  it("maps a missing organisation (FK violation) to 404", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO organisation_invitations/, pgError("23503"))
    expect((await createInvitation(db.client, "ghost", "a@b.test", ["member"], null)).status).toBe(404)
  })
})

describe("readInvitation", () => {
  it("returns the invitation with its organisation name", async () => {
    const db = new FakeDb()
    const row = { ...invitationRow(), org_name: "Acme" }
    db.on(/FROM organisation_invitations i/, { rows: [row] })
    expect(await readInvitation(db.client, "tok-1")).toEqual({
      success: true,
      invitation: row,
      status: 200,
    })
  })

  it("returns 404 when the token is unknown", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_invitations i/, { rows: [] })
    expect((await readInvitation(db.client, "tok-1")).status).toBe(404)
  })
})

describe("acceptInvitation", () => {
  it("spends the invitation and grants every offered role", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisation_invitations/, {
      rows: [{ org_uuid: "org-1", roles: ["member", "admin"], invited_by: "user-9" }],
    })
    db.on(/INSERT INTO organisation_members/, { rowCount: 1 })
    const result = await acceptInvitation(db.client, "tok-1", "user-1")
    expect(result).toEqual({ success: true, org_uuid: "org-1", status: 200 })
    // One membership insert per offered role.
    const inserts = db.calls.filter((c) => c.text.includes("INSERT INTO organisation_members"))
    expect(inserts).toHaveLength(2)
  })

  it("rejects an invalid, expired or already-used invitation with 400", async () => {
    const db = new FakeDb()
    db.on(/UPDATE organisation_invitations/, { rows: [] })
    const result = await acceptInvitation(db.client, "tok-1", "user-1")
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls.some((c) => c.text.includes("INSERT INTO organisation_members"))).toBe(false)
  })
})

describe("listInvitations", () => {
  it("returns the organisation's pending invitations", async () => {
    const db = new FakeDb()
    const rows = [invitationRow()]
    db.on(/WHERE org_uuid = \$1 AND is_used = FALSE/, { rows })
    expect(await listInvitations(db.client, "org-1")).toEqual({
      success: true,
      invitations: rows,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/WHERE org_uuid = \$1 AND is_used = FALSE/, pgError("08006"))
    expect((await listInvitations(db.client, "org-1")).status).toBe(500)
  })
})

describe("revokeInvitation", () => {
  it("revokes a pending invitation", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM organisation_invitations/, { rowCount: 1 })
    expect(await revokeInvitation(db.client, "org-1", "tok-1")).toEqual({
      success: true,
      status: 200,
    })
    // Scoped to the organisation so only its own invitations can be revoked.
    expect(db.calls[0].values).toEqual(["tok-1", "org-1"])
  })

  it("returns 404 when the invitation does not exist", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM organisation_invitations/, { rowCount: 0 })
    expect((await revokeInvitation(db.client, "org-1", "tok-1")).status).toBe(404)
  })
})
