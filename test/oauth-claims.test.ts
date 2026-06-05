import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb, pgError } from "./helpers/fake-db.js"

// oauth-claims is a composition layer over organisations + entitlements; the
// unit under test is its projection / filtering / grouping, so the two sibling
// modules are mocked and the claim shapes asserted directly.
const mocks = vi.hoisted(() => ({
  listOrganisationsForUser: vi.fn(),
  listEntitlementsForToken: vi.fn(),
}))
vi.mock("../src/organisations.js", () => ({ listOrganisationsForUser: mocks.listOrganisationsForUser }))
vi.mock("../src/entitlements.js", () => ({ listEntitlementsForToken: mocks.listEntitlementsForToken }))

const { buildMembershipsClaim, buildRolesClaim, buildEntitlementsClaim } = await import("../src/oauth-claims.js")

const org = (over: Partial<{ org_uuid: string; org_name: string; org_active: boolean; roles: string[] }> = {}) => ({
  org_uuid: "o1",
  org_name: "Org One",
  org_active: true,
  roles: ["org:owner"],
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("buildMembershipsClaim", () => {
  it("projects active orgs and filters disabled ones", async () => {
    mocks.listOrganisationsForUser.mockResolvedValue({
      success: true,
      organisations: [org(), org({ org_uuid: "o2", org_name: "Org Two", org_active: false })],
      status: 200,
    })
    const result = await buildMembershipsClaim(new FakeDb().client, "u1")
    expect(result).toEqual({ success: true, memberships: [{ org_uuid: "o1", org_name: "Org One" }], status: 200 })
  })

  it("propagates a downstream failure unchanged", async () => {
    mocks.listOrganisationsForUser.mockResolvedValue({ success: false, message: "nope", status: 403 })
    const result = await buildMembershipsClaim(new FakeDb().client, "u1")
    expect(result).toMatchObject({ success: false, status: 403 })
  })

  it("returns a 500 error envelope when the lookup throws", async () => {
    mocks.listOrganisationsForUser.mockRejectedValue(new Error("boom"))
    const result = await buildMembershipsClaim(new FakeDb().client, "u1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("buildRolesClaim", () => {
  it("groups team roles by org and team alongside org-level roles", async () => {
    mocks.listOrganisationsForUser.mockResolvedValue({
      success: true,
      organisations: [org(), org({ org_uuid: "o2", org_active: false })],
      status: 200,
    })
    const db = new FakeDb()
    db.on(/FROM team_members/, {
      rows: [
        { team_uuid: "t1", team_name: "Team One", org_uuid: "o1", role: "team:admin" },
        { team_uuid: "t1", team_name: "Team One", org_uuid: "o1", role: "team:member" },
        { team_uuid: "t2", team_name: "Team Two", org_uuid: "o1", role: "team:member" },
      ],
    })
    const result = await buildRolesClaim(db.client, "u1")
    expect(result).toEqual({
      success: true,
      status: 200,
      roles: [
        {
          org_uuid: "o1",
          org_name: "Org One",
          org_roles: ["org:owner"],
          team_roles: [
            { team_uuid: "t1", team_name: "Team One", roles: ["team:admin", "team:member"] },
            { team_uuid: "t2", team_name: "Team Two", roles: ["team:member"] },
          ],
        },
      ],
    })
  })

  it("propagates a downstream failure unchanged", async () => {
    mocks.listOrganisationsForUser.mockResolvedValue({ success: false, message: "nope", status: 403 })
    const result = await buildRolesClaim(new FakeDb().client, "u1")
    expect(result).toMatchObject({ success: false, status: 403 })
  })

  it("returns a 500 error envelope when the team-role query throws", async () => {
    mocks.listOrganisationsForUser.mockResolvedValue({ success: true, organisations: [org()], status: 200 })
    const db = new FakeDb()
    db.on(/FROM team_members/, pgError("XX000"))
    const result = await buildRolesClaim(db.client, "u1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("buildEntitlementsClaim", () => {
  const app = { app_uuid: "a1", app_licensing_mode: "seat" as const }

  it("returns a null claim when there is no org context", async () => {
    const result = await buildEntitlementsClaim(new FakeDb().client, app, "u1", null)
    expect(result).toEqual({ success: true, entitlements: null, status: 200 })
    expect(mocks.listEntitlementsForToken).not.toHaveBeenCalled()
  })

  it("returns the resolved entitlement claim for the bound org", async () => {
    mocks.listEntitlementsForToken.mockResolvedValue({ success: true, claim: { tier: "pro", perms: ["x"] }, status: 200 })
    const result = await buildEntitlementsClaim(new FakeDb().client, app, "u1", "o1")
    expect(result).toEqual({ success: true, entitlements: { tier: "pro", perms: ["x"] }, status: 200 })
  })

  it("propagates a downstream failure unchanged", async () => {
    mocks.listEntitlementsForToken.mockResolvedValue({ success: false, message: "nope", status: 404 })
    const result = await buildEntitlementsClaim(new FakeDb().client, app, "u1", "o1")
    expect(result).toMatchObject({ success: false, status: 404 })
  })
})
