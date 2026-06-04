// Claim payload builders for the puff-specific OIDC scopes. The OAuth token
// and userinfo endpoints both pull membership, role, and entitlement claims
// for the same user — this module is the single source of truth for those
// payload shapes so the two endpoints can never drift apart.
//
// All three builders are read-only: they do not write or mutate anything.

import { listEntitlementsForToken, type EntitlementClaim } from "./entitlements.js"
import { listOrganisationsForUser } from "./organisations.js"
import type { AppLicensingMode } from "./apps.js"

export interface MembershipClaim {
  org_uuid: string
  org_name: string
}

export interface RolesClaim {
  org_uuid: string
  org_name: string
  org_roles: string[]
  team_roles: { team_uuid: string; team_name: string; roles: string[] }[]
}

/**
 * Returns one claim per org the user belongs to. Uses
 * `listOrganisationsForUser` and projects only the public fields. Disabled
 * orgs are filtered out so consumers can treat the claim as "currently
 * active memberships".
 */
export async function buildMembershipsClaim(dbClient: DbClient, user_uuid: string): Promise<Envelope<{ memberships: MembershipClaim[] }>> {
  try {
    const result = await listOrganisationsForUser(dbClient, user_uuid)
    if (!result.success) return result
    const memberships = result.organisations.filter((o) => o.org_active).map((o) => ({ org_uuid: o.org_uuid, org_name: o.org_name }))
    return { success: true, memberships, status: 200 }
  } catch (error) {
    console.error("Error in buildMembershipsClaim:", error)
    return {
      error: true,
      message: "Could not build memberships claim.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Returns the user's full role assignment per org: org-level roles and the
 * team-level roles they hold in any team of that org. The shape mirrors
 * `MembershipClaim` but adds the role arrays so an app can authorise on
 * `puff:roles` without re-querying.
 */
export async function buildRolesClaim(dbClient: DbClient, user_uuid: string): Promise<Envelope<{ roles: RolesClaim[] }>> {
  try {
    const orgs = await listOrganisationsForUser(dbClient, user_uuid)
    if (!orgs.success) return orgs

    const { rows: teamRoleRows } = await dbClient.query(
      `SELECT tm.team_uuid, t.team_name, t.org_uuid, tm.role
         FROM team_members tm
         JOIN teams t ON t.team_uuid = tm.team_uuid
        WHERE tm.user_uuid = $1
        ORDER BY t.team_name ASC, tm.role ASC`,
      [user_uuid]
    )

    const teamsByOrg = new Map<string, Map<string, { team_uuid: string; team_name: string; roles: string[] }>>()
    for (const row of teamRoleRows) {
      if (!teamsByOrg.has(row.org_uuid)) {
        teamsByOrg.set(row.org_uuid, new Map())
      }
      const teams = teamsByOrg.get(row.org_uuid)!
      if (!teams.has(row.team_uuid)) {
        teams.set(row.team_uuid, {
          team_uuid: row.team_uuid,
          team_name: row.team_name,
          roles: [],
        })
      }
      teams.get(row.team_uuid)!.roles.push(row.role)
    }

    const roles: RolesClaim[] = orgs.organisations
      .filter((o) => o.org_active)
      .map((o) => ({
        org_uuid: o.org_uuid,
        org_name: o.org_name,
        org_roles: o.roles,
        team_roles: Array.from(teamsByOrg.get(o.org_uuid)?.values() ?? []),
      }))
    return { success: true, roles, status: 200 }
  } catch (error) {
    console.error("Error in buildRolesClaim:", error)
    return {
      error: true,
      message: "Could not build roles claim.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Returns the entitlements claim for the org context the OAuth grant was
 * bound to. Null `org_uuid` (which happens for `app_licensing_mode === 'none'`
 * apps) yields a null claim — the caller should omit the key from the token.
 */
export async function buildEntitlementsClaim(
  dbClient: DbClient,
  app: { app_uuid: string; app_licensing_mode: AppLicensingMode },
  user_uuid: string,
  org_uuid: string | null
): Promise<Envelope<{ entitlements: EntitlementClaim | null }>> {
  if (!org_uuid) {
    return { success: true, entitlements: null, status: 200 }
  }
  const result = await listEntitlementsForToken(dbClient, app, user_uuid, org_uuid)
  if (!result.success) return result
  return { success: true, entitlements: result.claim, status: 200 }
}
