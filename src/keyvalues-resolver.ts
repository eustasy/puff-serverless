// KV resolver — the unified read path that answers "what is the effective
// value of key K for user U (under owner O)?"
//
// Walks scopes most-specific → least-specific and returns the first tier with
// at least one hit:
//   1. user            — `user_key_values` for user_uuid
//   2. team-role       — `team_role_key_values` for user's roles in team_uuid
//   3. org-role        — `org_role_key_values` for user's roles in org_uuid
//   4. team            — `team_key_values` for team_uuid
//   5. org             — `organisation_key_values` for org_uuid
//   (app tier added in Phase 7 once `apps` lands)
//
// All tiers are filtered by the `owner` namespace, so an app/org never sees
// another's data. When the user holds multiple roles in the same scope and
// each role has a value for the key, the role-tier values are returned merged
// and de-duplicated (the caller decides how to combine them — see
// `kv-unified-design` memory).

import {
  Owner,
  ownerFilter,
  validatePair,
} from "./utilities/keyvalues-shared.js"

export type ResolveSource = "user" | "team-role" | "org-role" | "team" | "org"

export interface ResolveOptions {
  owner: Owner
  key: string
  user_uuid: string
  /** Optional org context — enables the `org-role` and `org` tiers. */
  org_uuid?: string
  /** Optional team context — enables the `team-role` and `team` tiers. */
  team_uuid?: string
}

export type ResolveResult = Envelope<{
  values: string[]
  source: ResolveSource | null
}>

/**
 * Resolves a key against the inheritance chain and returns the first tier
 * with at least one matching row. `values` is empty + `source` is null when
 * no tier has a hit; `values` may contain multiple entries only at the
 * role tiers (the user holds several roles, each with a value).
 */
export async function resolveKeyValue(
  dbClient: DbClient,
  opts: ResolveOptions
): Promise<ResolveResult> {
  const { owner, key, user_uuid, org_uuid, team_uuid } = opts

  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }

  try {
    // Tier 1 — user
    const userHit = await queryUserTier(dbClient, user_uuid, owner, key)
    if (userHit !== null) {
      return { success: true, values: [userHit], source: "user", status: 200 }
    }

    // Tier 2 — team-role (requires team context)
    if (team_uuid !== undefined) {
      const teamRoleHits = await queryTeamRoleTier(
        dbClient,
        team_uuid,
        user_uuid,
        owner,
        key
      )
      if (teamRoleHits.length > 0) {
        return {
          success: true,
          values: teamRoleHits,
          source: "team-role",
          status: 200,
        }
      }
    }

    // Tier 3 — org-role (requires org context)
    if (org_uuid !== undefined) {
      const orgRoleHits = await queryOrgRoleTier(
        dbClient,
        org_uuid,
        user_uuid,
        owner,
        key
      )
      if (orgRoleHits.length > 0) {
        return {
          success: true,
          values: orgRoleHits,
          source: "org-role",
          status: 200,
        }
      }
    }

    // Tier 4 — team
    if (team_uuid !== undefined) {
      const teamHit = await queryTeamTier(dbClient, team_uuid, owner, key)
      if (teamHit !== null) {
        return {
          success: true,
          values: [teamHit],
          source: "team",
          status: 200,
        }
      }
    }

    // Tier 5 — org
    if (org_uuid !== undefined) {
      const orgHit = await queryOrgTier(dbClient, org_uuid, owner, key)
      if (orgHit !== null) {
        return { success: true, values: [orgHit], source: "org", status: 200 }
      }
    }

    return { success: true, values: [], source: null, status: 200 }
  } catch (error) {
    console.error("Error in resolveKeyValue:", error)
    return {
      error: true,
      message: "Server error while resolving key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

async function queryUserTier(
  dbClient: DbClient,
  user_uuid: string,
  owner: Owner,
  key: string
): Promise<string | null> {
  const ownerWhere = ownerFilter(owner, 2)
  const result = await dbClient.query(
    `SELECT kv_value FROM user_key_values WHERE user_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
    [user_uuid, ...ownerWhere.values, key]
  )
  return result.rows.length === 0 ? null : result.rows[0].kv_value
}

async function queryTeamTier(
  dbClient: DbClient,
  team_uuid: string,
  owner: Owner,
  key: string
): Promise<string | null> {
  const ownerWhere = ownerFilter(owner, 2)
  const result = await dbClient.query(
    `SELECT kv_value FROM team_key_values WHERE team_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
    [team_uuid, ...ownerWhere.values, key]
  )
  return result.rows.length === 0 ? null : result.rows[0].kv_value
}

async function queryOrgTier(
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string
): Promise<string | null> {
  const ownerWhere = ownerFilter(owner, 2)
  const result = await dbClient.query(
    `SELECT kv_value FROM organisation_key_values WHERE org_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
    [org_uuid, ...ownerWhere.values, key]
  )
  return result.rows.length === 0 ? null : result.rows[0].kv_value
}

/**
 * Returns every distinct value a user has via team-roles they hold in
 * `team_uuid`. One row per matching role; de-duplicated across roles.
 */
async function queryTeamRoleTier(
  dbClient: DbClient,
  team_uuid: string,
  user_uuid: string,
  owner: Owner,
  key: string
): Promise<string[]> {
  const ownerWhere = ownerFilter(owner, 3)
  const result = await dbClient.query(
    `SELECT DISTINCT kv.kv_value
       FROM team_role_key_values kv
       JOIN team_members tm
         ON tm.team_uuid = kv.team_uuid AND tm.role = kv.role
      WHERE kv.team_uuid = $1
        AND tm.user_uuid = $2
        AND ${ownerWhere.sql}
        AND kv.kv_key = $4`,
    [team_uuid, user_uuid, ...ownerWhere.values, key]
  )
  return result.rows.map((row) => row.kv_value)
}

async function queryOrgRoleTier(
  dbClient: DbClient,
  org_uuid: string,
  user_uuid: string,
  owner: Owner,
  key: string
): Promise<string[]> {
  const ownerWhere = ownerFilter(owner, 3)
  const result = await dbClient.query(
    `SELECT DISTINCT kv.kv_value
       FROM org_role_key_values kv
       JOIN organisation_members om
         ON om.org_uuid = kv.org_uuid AND om.role = kv.role
      WHERE kv.org_uuid = $1
        AND om.user_uuid = $2
        AND ${ownerWhere.sql}
        AND kv.kv_key = $4`,
    [org_uuid, user_uuid, ...ownerWhere.values, key]
  )
  return result.rows.map((row) => row.kv_value)
}
