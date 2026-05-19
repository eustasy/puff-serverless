import { describe, it, expect } from "vitest"
import {
  can,
  isOrgRole,
  isTeamRole,
  ORG_ROLES,
  TEAM_ROLES,
  OWNER_ROLE,
  DEFAULT_ORG_ROLE,
  DEFAULT_TEAM_ROLE,
  type OrgAction,
  type TeamAction,
} from "../src/permissions.js"

describe("role constants", () => {
  it("exposes the organisation and team role sets", () => {
    expect(ORG_ROLES).toEqual(["owner", "admin", "member", "billing", "guest"])
    expect(TEAM_ROLES).toEqual(["lead", "member"])
  })

  it("names the privileged and default roles", () => {
    expect(OWNER_ROLE).toBe("owner")
    expect(DEFAULT_ORG_ROLE).toBe("member")
    expect(DEFAULT_TEAM_ROLE).toBe("member")
  })
})

describe("can — organisation actions", () => {
  const ALL_ORG_ACTIONS: OrgAction[] = [
    "org:view",
    "org:update",
    "org:disable",
    "org:delete",
    "org:billing",
    "org:members:view",
    "org:members:invite",
    "org:members:remove",
    "org:members:roles",
    "org:teams:create",
    "org:teams:manage",
    "org:keyvalues:read",
    "org:keyvalues:write",
  ]

  it("grants an owner every organisation action", () => {
    for (const action of ALL_ORG_ACTIONS) {
      expect(can(["owner"], action)).toBe(true)
    }
  })

  it("withholds org deletion, disable and billing from an admin", () => {
    expect(can(["admin"], "org:delete")).toBe(false)
    expect(can(["admin"], "org:disable")).toBe(false)
    expect(can(["admin"], "org:billing")).toBe(false)
    // ...but an admin still manages members and teams.
    expect(can(["admin"], "org:members:invite")).toBe(true)
    expect(can(["admin"], "org:teams:create")).toBe(true)
  })

  it("limits a plain member to read access", () => {
    expect(can(["member"], "org:view")).toBe(true)
    expect(can(["member"], "org:members:view")).toBe(true)
    expect(can(["member"], "org:members:invite")).toBe(false)
    expect(can(["member"], "org:teams:create")).toBe(false)
  })

  it("scopes billing to the owner and billing roles", () => {
    expect(can(["billing"], "org:billing")).toBe(true)
    expect(can(["owner"], "org:billing")).toBe(true)
    expect(can(["billing"], "org:update")).toBe(false)
  })

  it("limits a guest to org:view — nothing else at the org scope", () => {
    expect(can(["guest"], "org:view")).toBe(true)
    expect(can(["guest"], "org:members:view")).toBe(false)
    expect(can(["guest"], "org:keyvalues:read")).toBe(false)
    expect(can(["guest"], "org:update")).toBe(false)
    expect(can(["guest"], "org:teams:manage")).toBe(false)
  })

  it("treats the role set as a union — any granting role suffices", () => {
    expect(can(["member", "billing"], "org:billing")).toBe(true)
  })
})

describe("can — team actions", () => {
  const ALL_TEAM_ACTIONS: TeamAction[] = [
    "team:view",
    "team:update",
    "team:delete",
    "team:members:add",
    "team:members:remove",
    "team:members:roles",
    "team:keyvalues:read",
    "team:keyvalues:write",
  ]

  it("grants a team lead every team action", () => {
    for (const action of ALL_TEAM_ACTIONS) {
      expect(can(["lead"], action)).toBe(true)
    }
  })

  it("limits a team member to viewing", () => {
    expect(can(["member"], "team:view")).toBe(true)
    expect(can(["member"], "team:update")).toBe(false)
  })
})

describe("can — scope isolation", () => {
  it("does not let an org role satisfy a team action directly", () => {
    // An org owner manages teams via `org:teams:manage`; the endpoint composes
    // that with the team-scoped check rather than `can` crossing scopes.
    expect(can(["owner"], "team:delete")).toBe(false)
    expect(can(["owner"], "org:teams:manage")).toBe(true)
  })

  it("returns false for an empty role set or an unknown role", () => {
    expect(can([], "org:view")).toBe(false)
    expect(can(["bogus"], "org:view")).toBe(false)
  })

  it("resolves the shared `member` role name per scope", () => {
    expect(can(["member"], "org:view")).toBe(true)
    expect(can(["member"], "team:view")).toBe(true)
  })
})

describe("isOrgRole / isTeamRole", () => {
  it("accepts valid roles for their scope", () => {
    expect(isOrgRole("admin")).toBe(true)
    expect(isOrgRole("owner")).toBe(true)
    expect(isTeamRole("lead")).toBe(true)
  })

  it("rejects cross-scope, empty and non-string values", () => {
    expect(isOrgRole("lead")).toBe(false)
    expect(isTeamRole("owner")).toBe(false)
    expect(isOrgRole("")).toBe(false)
    expect(isOrgRole(null)).toBe(false)
    expect(isOrgRole(42)).toBe(false)
  })
})
