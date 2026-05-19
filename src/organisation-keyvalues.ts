// Organisation-subject key/value store. KV rows attached to an
// `organisations.org_uuid`, owned by a user or another organisation.
// Schema: sql/organisation_key_values.sql.

import {
  Owner,
  escapeLikePattern,
  ownerFilter,
  upsertKeyValue,
  validatePair,
} from "./utilities/keyvalues-shared.js"

const TABLE = "organisation_key_values"

/** Reads a single value for (org, owner, key). */
export async function readKeyValue(
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string
): Promise<Envelope<{ value: string }>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `SELECT kv_value FROM ${TABLE} WHERE org_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
      [org_uuid, ...ownerWhere.values, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error("Error in organisation-keyvalues readKeyValue:", error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Reads every (key, value) row a single owner has stored against an organisation. */
export async function readKeyValues(
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner
): Promise<Envelope<{ pairs: OrganisationKeyValueRow[] }>> {
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `SELECT org_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE org_uuid = $1 AND ${ownerWhere.sql} ORDER BY kv_key ASC`,
      [org_uuid, ...ownerWhere.values]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in organisation-keyvalues readKeyValues:", error)
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
  org_uuid: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: OrganisationKeyValueRow[] }>> {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return {
      success: false,
      message: "A search term is required.",
      status: 400,
    }
  }
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `SELECT org_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE org_uuid = $1 AND ${ownerWhere.sql} AND kv_key LIKE $3 ESCAPE '\\' ORDER BY kv_key ASC`,
      [org_uuid, ...ownerWhere.values, `%${escapeLikePattern(pattern)}%`]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in organisation-keyvalues searchKeyValues:", error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Upsert (create or replace) a value for (org, owner, key). */
export function setKeyValue(
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  return upsertKeyValue(
    dbClient,
    TABLE,
    ["org_uuid"],
    [org_uuid],
    owner,
    key,
    value
  )
}

/** Removes (org, owner, key); 404 if no such row. */
export async function deleteKeyValue(
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string
): Promise<Envelope<{}>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `DELETE FROM ${TABLE} WHERE org_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3`,
      [org_uuid, ...ownerWhere.values, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in organisation-keyvalues deleteKeyValue:", error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
