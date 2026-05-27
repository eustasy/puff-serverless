// Shared primitives for the six per-subject KV modules
// (`user-keyvalues`, `team-keyvalues`, `organisation-keyvalues`,
// `org-role-keyvalues`, `team-role-keyvalues`, `app-keyvalues`).
//
// Each subject table follows the same shape:
//   (subject..., kv_key, kv_value,
//    owner_user_uuid, owner_org_uuid, owner_app_uuid,
//    owner_id [STORED = COALESCE(owner_user_uuid, owner_org_uuid, owner_app_uuid)],
//    created_at, updated_at)
// with a CHECK that exactly one owner column is set, FKs from every column,
// and CASCADE on both subject and owner deletion. The owner is first-class:
// (subject, owner_id, kv_key) is the unique tuple, so an app A's value and an
// org O's value for the same (subject, key) coexist as different rows.

import { runInTransaction, Rollback } from "./transaction.js"

// Parity with the PHP `KeyValues.Key` column (varchar(128)).
export const MAX_KEY_LENGTH = 128
// Widened from 128 — "arbitrary metadata" outgrows that quickly. Same as
// before; per-subject so a row's blast radius stays bounded.
export const MAX_VALUE_LENGTH = 4096
// Soft abuse guard on the number of distinct keys a single owner may hold
// against a single subject. The owner dimension is part of the limit because
// (subject, owner) is the unique namespace.
export const MAX_KEYS_PER_OWNER_SUBJECT = 256

/** First-class owner. Exactly one variant per row. */
export type Owner =
  | { type: "user"; user_uuid: string }
  | { type: "org"; org_uuid: string }
  | { type: "app"; app_uuid: string }

/**
 * SQL fragment + parameter values for filtering a query to a specific owner.
 * Use with a parameter index offset so the fragment slots into a larger query.
 *
 * Example: `ownerFilter({ type: "org", org_uuid: "..." }, 2)` returns
 * `{ sql: "owner_org_uuid = $2", values: ["..."] }` — append `values` to the
 * caller's parameter array, splice `sql` into the WHERE clause.
 */
export function ownerFilter(
  owner: Owner,
  paramIndex: number
): { sql: string; values: [string] } {
  if (owner.type === "user") {
    return {
      sql: `owner_user_uuid = $${paramIndex}`,
      values: [owner.user_uuid],
    }
  }
  if (owner.type === "org") {
    return { sql: `owner_org_uuid = $${paramIndex}`, values: [owner.org_uuid] }
  }
  return { sql: `owner_app_uuid = $${paramIndex}`, values: [owner.app_uuid] }
}

/**
 * Returns the (owner_user_uuid, owner_org_uuid, owner_app_uuid) value triple
 * for INSERT statements. Exactly one is the owner's UUID; the others are
 * `null`.
 */
export function ownerInsertValues(
  owner: Owner
): [string | null, string | null, string | null] {
  if (owner.type === "user") {
    return [owner.user_uuid, null, null]
  }
  if (owner.type === "org") {
    return [null, owner.org_uuid, null]
  }
  return [null, null, owner.app_uuid]
}

/**
 * Validates a key/value pair against the length and emptiness rules. Returns
 * an error message, or `null` when valid. Omit `value` to validate the key
 * only (used by read/delete paths).
 */
export function validatePair(key: string, value?: string): string | null {
  if (typeof key !== "string" || key.trim() === "") {
    return "A key is required."
  }
  if (key.length > MAX_KEY_LENGTH) {
    return `Keys cannot be longer than ${MAX_KEY_LENGTH} characters.`
  }
  if (value !== undefined) {
    if (typeof value !== "string") {
      return "A value is required."
    }
    if (value.length > MAX_VALUE_LENGTH) {
      return `Values cannot be longer than ${MAX_VALUE_LENGTH} characters.`
    }
  }
  return null
}

/**
 * Escapes the LIKE wildcards (`%`, `_`) and the escape character (`\`) so a
 * user-supplied pattern is matched as a literal substring.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Per-table configuration for the generic CRUD helpers. The six KV modules
 * are identical apart from this triple; binding it once per file removes the
 * per-call repetition without losing type safety on the row shape.
 */
export interface KeyValueSpec {
  /** SQL table name (e.g. `user_key_values`). */
  table: string
  /** Subject columns in the same order the caller passes their values. */
  subjectColumns: readonly string[]
  /** Column list for SELECTs that return full rows (list / search). */
  selectColumns: string
  /** Short label used in error logs (e.g. `user-keyvalues`). */
  label: string
}

/** Reads a single value by (subject..., owner, key). */
export async function readKeyValueGeneric(
  dbClient: DbClient,
  spec: KeyValueSpec,
  subjectValues: readonly unknown[],
  owner: Owner,
  key: string
): Promise<Envelope<{ value: string }>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const subjectWhere = spec.subjectColumns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(" AND ")
    const ownerParamIndex = spec.subjectColumns.length + 1
    const ownerWhere = ownerFilter(owner, ownerParamIndex)
    const keyParamIndex = ownerParamIndex + 1
    const result = await dbClient.query(
      `SELECT kv_value FROM ${spec.table} WHERE ${subjectWhere} AND ${ownerWhere.sql} AND kv_key = $${keyParamIndex} LIMIT 1`,
      [...subjectValues, ...ownerWhere.values, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error(`Error in ${spec.label} readKeyValue:`, error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Reads every row a single owner has stored against the subject. */
export async function readKeyValuesGeneric<RowT>(
  dbClient: DbClient,
  spec: KeyValueSpec,
  subjectValues: readonly unknown[],
  owner: Owner
): Promise<Envelope<{ pairs: RowT[] }>> {
  try {
    const subjectWhere = spec.subjectColumns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(" AND ")
    const ownerParamIndex = spec.subjectColumns.length + 1
    const ownerWhere = ownerFilter(owner, ownerParamIndex)
    const result = await dbClient.query(
      `SELECT ${spec.selectColumns} FROM ${spec.table} WHERE ${subjectWhere} AND ${ownerWhere.sql} ORDER BY kv_key ASC`,
      [...subjectValues, ...ownerWhere.values]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error(`Error in ${spec.label} readKeyValues:`, error)
    return {
      error: true,
      message: "Server error while reading key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export async function searchKeyValuesGeneric<RowT>(
  dbClient: DbClient,
  spec: KeyValueSpec,
  subjectValues: readonly unknown[],
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: RowT[] }>> {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return {
      success: false,
      message: "A search term is required.",
      status: 400,
    }
  }
  try {
    const subjectWhere = spec.subjectColumns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(" AND ")
    const ownerParamIndex = spec.subjectColumns.length + 1
    const ownerWhere = ownerFilter(owner, ownerParamIndex)
    const patternParamIndex = ownerParamIndex + 1
    const result = await dbClient.query(
      `SELECT ${spec.selectColumns} FROM ${spec.table} WHERE ${subjectWhere} AND ${ownerWhere.sql} AND kv_key LIKE $${patternParamIndex} ESCAPE '\\' ORDER BY kv_key ASC`,
      [
        ...subjectValues,
        ...ownerWhere.values,
        `%${escapeLikePattern(pattern)}%`,
      ]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error(`Error in ${spec.label} searchKeyValues:`, error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Removes (subject..., owner, key); 404 if no such row. */
export async function deleteKeyValueGeneric(
  dbClient: DbClient,
  spec: KeyValueSpec,
  subjectValues: readonly unknown[],
  owner: Owner,
  key: string
): Promise<Envelope<{}>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const subjectWhere = spec.subjectColumns
      .map((col, i) => `${col} = $${i + 1}`)
      .join(" AND ")
    const ownerParamIndex = spec.subjectColumns.length + 1
    const ownerWhere = ownerFilter(owner, ownerParamIndex)
    const keyParamIndex = ownerParamIndex + 1
    const result = await dbClient.query(
      `DELETE FROM ${spec.table} WHERE ${subjectWhere} AND ${ownerWhere.sql} AND kv_key = $${keyParamIndex}`,
      [...subjectValues, ...ownerWhere.values, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error(`Error in ${spec.label} deleteKeyValue:`, error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Builds the upsert query that all five subject modules use. `table` is the
 * SQL table name; `subjectColumns` and `subjectValues` describe the subject
 * portion of the row (e.g. `["user_uuid"]` / `[user_uuid]` for the user table,
 * `["org_uuid","role"]` / `[org_uuid, role]` for the org-role table).
 */
function buildUpsertQuery(
  table: string,
  subjectColumns: readonly string[],
  subjectValues: readonly unknown[],
  owner: Owner,
  key: string,
  value: string
): { sql: string; values: unknown[] } {
  const [ownerUser, ownerOrg, ownerApp] = ownerInsertValues(owner)
  const columns = [
    ...subjectColumns,
    "kv_key",
    "kv_value",
    "owner_user_uuid",
    "owner_org_uuid",
    "owner_app_uuid",
  ]
  const values: unknown[] = [
    ...subjectValues,
    key,
    value,
    ownerUser,
    ownerOrg,
    ownerApp,
  ]
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ")
  // The conflict target uses `owner_id` (the generated COALESCE column), so a
  // row with the same subject + owner + key gets UPDATEd regardless of which
  // owner column is set.
  const conflictTarget = [...subjectColumns, "owner_id", "kv_key"].join(", ")
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO UPDATE SET kv_value = excluded.kv_value, updated_at = NOW()`
  return { sql, values }
}

/**
 * Shared upsert flow for every subject table. SERIALIZABLE isolation makes
 * the count-check + insert race-free: a concurrent insert that would push the
 * key count past the limit forces a serialization failure, which
 * `runInTransaction` retries.
 *
 * The count check counts rows for `(subject, owner)` only — different owners
 * have independent budgets against the same subject.
 */
export async function upsertKeyValue(
  dbClient: DbClient,
  table: string,
  subjectColumns: readonly string[],
  subjectValues: readonly unknown[],
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  const invalid = validatePair(key, value)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    type SetResult = Envelope<{ created: boolean }>
    return await runInTransaction(dbClient, async (): Promise<SetResult> => {
      const subjectWhere = subjectColumns
        .map((col, i) => `${col} = $${i + 1}`)
        .join(" AND ")
      const ownerParamIndex = subjectColumns.length + 1
      const ownerWhere = ownerFilter(owner, ownerParamIndex)
      const checkParams = [...subjectValues, ...ownerWhere.values]

      const existing = await dbClient.query(
        `SELECT 1 FROM ${table} WHERE ${subjectWhere} AND ${ownerWhere.sql} AND kv_key = $${ownerParamIndex + 1} LIMIT 1`,
        [...checkParams, key]
      )
      const isNewKey = (existing.rowCount ?? 0) === 0

      if (isNewKey) {
        const countResult = await dbClient.query(
          `SELECT count(*)::INT AS count FROM ${table} WHERE ${subjectWhere} AND ${ownerWhere.sql}`,
          checkParams
        )
        if (countResult.rows[0].count >= MAX_KEYS_PER_OWNER_SUBJECT) {
          throw new Rollback<SetResult>({
            success: false,
            message: `The ${MAX_KEYS_PER_OWNER_SUBJECT}-key limit for this owner has been reached. Remove a key before adding another.`,
            status: 409,
          })
        }
      }

      const upsert = buildUpsertQuery(
        table,
        subjectColumns,
        subjectValues,
        owner,
        key,
        value
      )
      await dbClient.query(upsert.sql, upsert.values)
      return { success: true, created: isNewKey, status: isNewKey ? 201 : 200 }
    })
  } catch (error) {
    console.error(`Error in upsertKeyValue on ${table}:`, error)
    return {
      error: true,
      message: "Server error while saving key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
