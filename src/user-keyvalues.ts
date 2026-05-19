// User-subject key/value store. The serverless successor to the PHP server's
// `KeyValues` table — generalised here so any owner (a user themselves, or an
// organisation, and later a linked app) can attach key/value rows to a user.
//
// SQL schema: sql/user_key_values.sql. The composite primary key
// (user_uuid, owner_id, kv_key) makes the (subject, owner, key) triple
// unique — the owner is first-class, so app-owned and org-owned rows about
// the same user with the same key coexist.

import {
  Owner,
  escapeLikePattern,
  ownerFilter,
  upsertKeyValue,
  validatePair,
} from "./utilities/keyvalues-shared.js"

export type { Owner } from "./utilities/keyvalues-shared.js"
export {
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  MAX_KEYS_PER_OWNER_SUBJECT,
} from "./utilities/keyvalues-shared.js"

const TABLE = "user_key_values"

/** Reads a single value for (user, owner, key). */
export async function readKeyValue(
  dbClient: DbClient,
  user_uuid: string,
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
      `SELECT kv_value FROM ${TABLE} WHERE user_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
      [user_uuid, ...ownerWhere.values, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error("Error in user-keyvalues readKeyValue:", error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Reads every (key, value) row a single owner has stored against a user. */
export async function readKeyValues(
  dbClient: DbClient,
  user_uuid: string,
  owner: Owner
): Promise<Envelope<{ pairs: UserKeyValueRow[] }>> {
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `SELECT user_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE user_uuid = $1 AND ${ownerWhere.sql} ORDER BY kv_key ASC`,
      [user_uuid, ...ownerWhere.values]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in user-keyvalues readKeyValues:", error)
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
  user_uuid: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: UserKeyValueRow[] }>> {
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
      `SELECT user_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE user_uuid = $1 AND ${ownerWhere.sql} AND kv_key LIKE $3 ESCAPE '\\' ORDER BY kv_key ASC`,
      [user_uuid, ...ownerWhere.values, `%${escapeLikePattern(pattern)}%`]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in user-keyvalues searchKeyValues:", error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Upsert (create or replace) a value for (user, owner, key). */
export function setKeyValue(
  dbClient: DbClient,
  user_uuid: string,
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  return upsertKeyValue(
    dbClient,
    TABLE,
    ["user_uuid"],
    [user_uuid],
    owner,
    key,
    value
  )
}

/** Removes (user, owner, key); 404 if no such row. */
export async function deleteKeyValue(
  dbClient: DbClient,
  user_uuid: string,
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
      `DELETE FROM ${TABLE} WHERE user_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3`,
      [user_uuid, ...ownerWhere.values, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in user-keyvalues deleteKeyValue:", error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
