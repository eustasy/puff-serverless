// App-subject key/value store. KV rows attached to an `apps.app_uuid`, owned
// by a user / organisation / app. Schema: sql/app_key_values.sql.
//
// Conceptually this is the **app tier** of the inheritance chain — when the
// resolver walks user → team-role → org-role → team → org → app and no
// earlier tier hits, the app's own globally-applied defaults (rows where
// `app_uuid` and `owner_app_uuid` are the same app) are the final fallback.

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

const TABLE = "app_key_values"

/** Reads a single value for (app, owner, key). */
export async function readKeyValue(
  dbClient: DbClient,
  app_uuid: string,
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
      `SELECT kv_value FROM ${TABLE} WHERE app_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3 LIMIT 1`,
      [app_uuid, ...ownerWhere.values, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error("Error in app-keyvalues readKeyValue:", error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Reads every (key, value) row a single owner has stored against an app. */
export async function readKeyValues(
  dbClient: DbClient,
  app_uuid: string,
  owner: Owner
): Promise<Envelope<{ pairs: AppKeyValueRow[] }>> {
  try {
    const ownerWhere = ownerFilter(owner, 2)
    const result = await dbClient.query(
      `SELECT app_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE app_uuid = $1 AND ${ownerWhere.sql} ORDER BY kv_key ASC`,
      [app_uuid, ...ownerWhere.values]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in app-keyvalues readKeyValues:", error)
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
  app_uuid: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: AppKeyValueRow[] }>> {
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
      `SELECT app_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at FROM ${TABLE} WHERE app_uuid = $1 AND ${ownerWhere.sql} AND kv_key LIKE $3 ESCAPE '\\' ORDER BY kv_key ASC`,
      [app_uuid, ...ownerWhere.values, `%${escapeLikePattern(pattern)}%`]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in app-keyvalues searchKeyValues:", error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Upsert (create or replace) a value for (app, owner, key). */
export function setKeyValue(
  dbClient: DbClient,
  app_uuid: string,
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  return upsertKeyValue(
    dbClient,
    TABLE,
    ["app_uuid"],
    [app_uuid],
    owner,
    key,
    value
  )
}

/** Removes (app, owner, key); 404 if no such row. */
export async function deleteKeyValue(
  dbClient: DbClient,
  app_uuid: string,
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
      `DELETE FROM ${TABLE} WHERE app_uuid = $1 AND ${ownerWhere.sql} AND kv_key = $3`,
      [app_uuid, ...ownerWhere.values, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in app-keyvalues deleteKeyValue:", error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
