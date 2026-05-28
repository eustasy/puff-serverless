// Role and capability model for organisations and teams (Phase 6).
//
// Two scopes, each with its own role set: a user holds organisation-scoped
// roles in `organisation_members.role` and team-scoped roles in
// `team_members.role`, and may hold any number of either. Authorisation is by
// *capability*, never by a raw role string — endpoints ask `can(roles, action)`
// so the role-to-action mapping can change (Phase 7 moves it into a
// `role_permissions` table) without touching call sites.
//
// This module is pure: no database, no I/O. The membership tables and the
// guest / full-member distinction are handled in `src/memberships.ts`.

// --- Roles -----------------------------------------------------------------

/**
 * Organisation-scoped roles, stored in `organisation_members.role`.
 *
 * `guest` is the explicit marker for users attached to the organisation only
 * through team memberships — they hold an `organisation_members` row with this
 * role and an otherwise-empty org capability set (only `org:view`, enough to
 * render the org page they belong to). Their actual access to teams flows
 * from `team_members` rows as usual; the org role itself grants nothing beyond
 * visibility of the organisation's existence.
 */
export const ORG_ROLES = [
  "owner",
  "admin",
  "member",
  "billing",
  "guest",
] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/** Team-scoped roles, stored in `team_members.role`. */
export const TEAM_ROLES = ["lead", "member"] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

/**
 * The privileged organisation role. An organisation must always retain at
 * least one `owner`; that guard lives in `src/memberships.ts`.
 */
export const OWNER_ROLE: OrgRole = "owner"

/** Role granted to a newly-added organisation member when none is specified. */
export const DEFAULT_ORG_ROLE: OrgRole = "member"

/** Role granted to a newly-added team member when none is specified. */
export const DEFAULT_TEAM_ROLE: TeamRole = "member"

// --- Actions ---------------------------------------------------------------

/**
 * Organisation-scoped actions — authorised against a user's `OrgRole`s.
 * `org:teams:*` is org-level control over every team in the organisation: an
 * org admin can manage a team without holding a role on that team.
 */
export type OrgAction =
  | "org:view"
  | "org:update"
  | "org:disable"
  | "org:delete"
  | "org:billing:read"
  | "org:billing:write"
  | "org:members:view"
  | "org:members:invite"
  | "org:members:remove"
  | "org:members:roles"
  | "org:teams:create"
  | "org:teams:manage"
  | "org:keyvalues:read"
  | "org:keyvalues:write"
  | "org:entitlements:read"
  | "org:entitlements:write"

/** Team-scoped actions — authorised against a user's `TeamRole`s. */
export type TeamAction =
  | "team:view"
  | "team:update"
  | "team:delete"
  | "team:members:add"
  | "team:members:remove"
  | "team:members:roles"
  | "team:keyvalues:read"
  | "team:keyvalues:write"

// --- Capability matrix -----------------------------------------------------
// Role -> the actions it grants. Coarse-grained on purpose: rules that depend
// on the *target* as well as the actor — e.g. an admin may set member roles but
// may not grant or revoke `owner` — are enforced in `src/memberships.ts`, not
// here.

const ORG_ROLE_ACTIONS: Record<OrgRole, readonly OrgAction[]> = {
  owner: [
    "org:view",
    "org:update",
    "org:disable",
    "org:delete",
    "org:billing:read",
    "org:billing:write",
    "org:members:view",
    "org:members:invite",
    "org:members:remove",
    "org:members:roles",
    "org:teams:create",
    "org:teams:manage",
    "org:keyvalues:read",
    "org:keyvalues:write",
    "org:entitlements:read",
    "org:entitlements:write",
  ],
  admin: [
    "org:view",
    "org:update",
    "org:billing:read",
    "org:members:view",
    "org:members:invite",
    "org:members:remove",
    "org:members:roles",
    "org:teams:create",
    "org:teams:manage",
    "org:keyvalues:read",
    "org:keyvalues:write",
    "org:entitlements:read",
    "org:entitlements:write",
  ],
  member: ["org:view", "org:members:view", "org:keyvalues:read"],
  billing: [
    "org:view",
    "org:billing:read",
    "org:billing:write",
    "org:keyvalues:read",
    "org:entitlements:read",
  ],
  guest: ["org:view"],
}

const TEAM_ROLE_ACTIONS: Record<TeamRole, readonly TeamAction[]> = {
  lead: [
    "team:view",
    "team:update",
    "team:delete",
    "team:members:add",
    "team:members:remove",
    "team:members:roles",
    "team:keyvalues:read",
    "team:keyvalues:write",
  ],
  member: ["team:view", "team:keyvalues:read"],
}

function toCapabilitySets(
  matrix: Record<string, readonly string[]>
): Map<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(matrix).map(([role, actions]) => [role, new Set(actions)])
  )
}

const ORG_CAPABILITIES = toCapabilitySets(ORG_ROLE_ACTIONS)
const TEAM_CAPABILITIES = toCapabilitySets(TEAM_ROLE_ACTIONS)

// --- can() -----------------------------------------------------------------

/**
 * True if any role in `roles` grants `action`. The action's prefix selects the
 * scope: `team:*` actions are checked against team roles, every other action
 * against organisation roles — so pass the user's role set for the scope that
 * matches the action.
 *
 * `roles` is a plain string array because roles arrive from the database as
 * text; unknown values simply grant nothing. A team action that an org admin
 * should also be allowed to perform is the caller's job to compose, e.g.
 * `can(orgRoles, "org:teams:manage") || can(teamRoles, "team:update")`.
 */
export function can(
  roles: readonly string[],
  action: OrgAction | TeamAction
): boolean {
  const capabilities = action.startsWith("team:")
    ? TEAM_CAPABILITIES
    : ORG_CAPABILITIES
  return roles.some((role) => capabilities.get(role)?.has(action) ?? false)
}

// --- Role validation -------------------------------------------------------
// Endpoints receive role names as user input when granting a role and must
// validate them before they reach the database.

/** Type guard: `value` is a valid organisation role. */
export function isOrgRole(value: unknown): value is OrgRole {
  return (
    typeof value === "string" &&
    (ORG_ROLES as readonly string[]).includes(value)
  )
}

/** Type guard: `value` is a valid team role. */
export function isTeamRole(value: unknown): value is TeamRole {
  return (
    typeof value === "string" &&
    (TEAM_ROLES as readonly string[]).includes(value)
  )
}
