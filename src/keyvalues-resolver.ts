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
//   6. app             — `app_key_values` for owner.app_uuid (only fires when
//                        owner.type === "app"; this is the app's own
//                        globally-applied default for all of its users)
//
// All tiers are filtered by the `owner` namespace, so an app/org never sees
// another's data. When the user holds multiple roles in the same scope and
// each role has a value for the key, the role-tier values are returned merged
// and de-duplicated (the caller decides how to combine them — see
// `kv-unified-design` memory).

import { Owner, ownerFilter, validatePair } from "./utilities/keyvalues-shared.js"

export type ResolveSource = "user" | "team-role" | "org-role" | "team" | "org" | "app"

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
export async function resolveKeyValue(dbClient: DbClient, opts: ResolveOptions): Promise<ResolveResult> {
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
      const teamRoleHits = await queryTeamRoleTier(dbClient, team_uuid, user_uuid, owner, key)
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
      const orgRoleHits = await queryOrgRoleTier(dbClient, org_uuid, user_uuid, owner, key)
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

    // Tier 6 — app (the app's own globally-applied default; only meaningful
    // when the owner namespace is an app, since the subject of `app_key_values`
    // is the app itself).
    if (owner.type === "app") {
      const appHit = await queryAppTier(dbClient, owner.app_uuid, owner, key)
      if (appHit !== null) {
        return { success: true, values: [appHit], source: "app", status: 200 }
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

// Shared body of the four single-value tiers (user / team / org / app). They
// differ only in the table and its id column, both internal literals supplied
// by the named wrappers below (never caller input), so interpolating them is
// safe. Returns the single `kv_value`, or null when the tier has no row.
async function querySingleTier(
  dbClient: DbClient,
  table: string,
  idColumn: string,
  id: string,
  owner: Owner,
  key: string
): Promise<string | null> {
  const ownerWhere = ownerFilter(owner, 2)
  const result = await dbClient.query(
    `SELECT kv_value FROM ${table} WHERE ${idColumn} = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
    [id, ...ownerWhere.values, key]
  )
  return result.rows.length === 0 ? null : result.rows[0].kv_value
}

async function queryUserTier(dbClient: DbClient, user_uuid: string, owner: Owner, key: string): Promise<string | null> {
  return await querySingleTier(dbClient, "user_key_values", "user_uuid", user_uuid, owner, key)
}

async function queryTeamTier(dbClient: DbClient, team_uuid: string, owner: Owner, key: string): Promise<string | null> {
  return await querySingleTier(dbClient, "team_key_values", "team_uuid", team_uuid, owner, key)
}

async function queryOrgTier(dbClient: DbClient, org_uuid: string, owner: Owner, key: string): Promise<string | null> {
  return await querySingleTier(dbClient, "organisation_key_values", "org_uuid", org_uuid, owner, key)
}

async function queryAppTier(dbClient: DbClient, app_uuid: string, owner: Owner, key: string): Promise<string | null> {
  return await querySingleTier(dbClient, "app_key_values", "app_uuid", app_uuid, owner, key)
}

// Shared body of the two role tiers (team-role / org-role). They differ only in
// the KV table, the membership table, and the scope column (`team_uuid` /
// `org_uuid`) — all internal literals from the wrappers below, never caller
// input. Returns every distinct value the user holds via their roles in the
// scope, de-duplicated across roles.
async function queryRoleTier(
  dbClient: DbClient,
  kvTable: string,
  memberTable: string,
  scopeColumn: string,
  scopeId: string,
  user_uuid: string,
  owner: Owner,
  key: string
): Promise<string[]> {
  const ownerWhere = ownerFilter(owner, 3)
  const result = await dbClient.query(
    `SELECT DISTINCT kv.kv_value
       FROM ${kvTable} kv
       JOIN ${memberTable} m
         ON m.${scopeColumn} = kv.${scopeColumn} AND m.role = kv.role
      WHERE kv.${scopeColumn} = $1
        AND m.user_uuid = $2
        AND ${ownerWhere.sql}
        AND kv.kv_key = $4`,
    [scopeId, user_uuid, ...ownerWhere.values, key]
  )
  return result.rows.map((row) => row.kv_value)
}

/**
 * Returns every distinct value a user has via team-roles they hold in
 * `team_uuid`. One row per matching role; de-duplicated across roles.
 */
async function queryTeamRoleTier(dbClient: DbClient, team_uuid: string, user_uuid: string, owner: Owner, key: string): Promise<string[]> {
  return await queryRoleTier(dbClient, "team_role_key_values", "team_members", "team_uuid", team_uuid, user_uuid, owner, key)
}

async function queryOrgRoleTier(dbClient: DbClient, org_uuid: string, user_uuid: string, owner: Owner, key: string): Promise<string[]> {
  return await queryRoleTier(dbClient, "org_role_key_values", "organisation_members", "org_uuid", org_uuid, user_uuid, owner, key)
}
