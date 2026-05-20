// Team-role-subject key/value store. KV rows attached to a (team_uuid, role)
// tuple — perms and metadata that apply to every user holding `role` in the
// team. Schema: sql/team_role_key_values.sql.

import { isTeamRole } from "./permissions.js"
import {
  Owner,
  escapeLikePattern,
  ownerFilter,
  upsertKeyValue,
  validatePair,
} from "./utilities/keyvalues-shared.js"

const TABLE = "team_role_key_values"

function invalidRole(role: string): string | null {
  return isTeamRole(role) ? null : "Unknown team role."
}

/** Reads a single value for (team, role, owner, key). */
export async function readKeyValue(
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{ value: string }>> {
  const roleErr = invalidRole(role)
  if (roleErr) return { success: false, message: roleErr, status: 400 }
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const ownerWhere = ownerFilter(owner, 3)
    const result = await dbClient.query(
      `SELECT kv_value FROM ${TABLE} WHERE team_uuid = $1 AND role = $2 AND ${ownerWhere.sql} AND kv_key = $4 LIMIT 1`,
      [team_uuid, role, ...ownerWhere.values, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error("Error in team-role-keyvalues readKeyValue:", error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Reads every (key, value) row for a team+role under a single owner. */
export async function readKeyValues(
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner
): Promise<Envelope<{ pairs: TeamRoleKeyValueRow[] }>> {
  const roleErr = invalidRole(role)
  if (roleErr) return { success: false, message: roleErr, status: 400 }
  try {
    const ownerWhere = ownerFilter(owner, 3)
    const result = await dbClient.query(
      `SELECT team_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE team_uuid = $1 AND role = $2 AND ${ownerWhere.sql} ORDER BY kv_key ASC`,
      [team_uuid, role, ...ownerWhere.values]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in team-role-keyvalues readKeyValues:", error)
    return {
      error: true,
      message: "Server error while reading key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export async function searchKeyValues(
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: TeamRoleKeyValueRow[] }>> {
  const roleErr = invalidRole(role)
  if (roleErr) return { success: false, message: roleErr, status: 400 }
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return {
      success: false,
      message: "A search term is required.",
      status: 400,
    }
  }
  try {
    const ownerWhere = ownerFilter(owner, 3)
    const result = await dbClient.query(
      `SELECT team_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE team_uuid = $1 AND role = $2 AND ${ownerWhere.sql} AND kv_key LIKE $4 ESCAPE '\\' ORDER BY kv_key ASC`,
      [team_uuid, role, ...ownerWhere.values, `%${escapeLikePattern(pattern)}%`]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in team-role-keyvalues searchKeyValues:", error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Upsert (create or replace) a value for (team, role, owner, key). */
export function setKeyValue(
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  const roleErr = invalidRole(role)
  if (roleErr)
    return Promise.resolve({ success: false, message: roleErr, status: 400 })
  return upsertKeyValue(
    dbClient,
    TABLE,
    ["team_uuid", "role"],
    [team_uuid, role],
    owner,
    key,
    value
  )
}

/** Removes (team, role, owner, key); 404 if no such row. */
export async function deleteKeyValue(
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{}>> {
  const roleErr = invalidRole(role)
  if (roleErr) return { success: false, message: roleErr, status: 400 }
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const ownerWhere = ownerFilter(owner, 3)
    const result = await dbClient.query(
      `DELETE FROM ${TABLE} WHERE team_uuid = $1 AND role = $2 AND ${ownerWhere.sql} AND kv_key = $4`,
      [team_uuid, role, ...ownerWhere.values, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in team-role-keyvalues deleteKeyValue:", error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
