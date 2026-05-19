// Shared primitives for the five per-subject KV modules
// (`user-keyvalues`, `team-keyvalues`, `organisation-keyvalues`,
// `org-role-keyvalues`, `team-role-keyvalues`).
//
// Each subject table follows the same shape:
//   (subject..., kv_key, kv_value, owner_user_uuid, owner_org_uuid,
//    owner_id [STORED = COALESCE(owner_user_uuid, owner_org_uuid)],
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
  return { sql: `owner_org_uuid = $${paramIndex}`, values: [owner.org_uuid] }
}

/**
 * Returns the (owner_user_uuid, owner_org_uuid) value pair for INSERT
 * statements. Exactly one is the owner's UUID; the other is `null`.
 */
export function ownerInsertValues(
  owner: Owner
): [string | null, string | null] {
  if (owner.type === "user") {
    return [owner.user_uuid, null]
  }
  return [null, owner.org_uuid]
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
  const [ownerUser, ownerOrg] = ownerInsertValues(owner)
  const columns = [
    ...subjectColumns,
    "kv_key",
    "kv_value",
    "owner_user_uuid",
    "owner_org_uuid",
  ]
  const values: unknown[] = [...subjectValues, key, value, ownerUser, ownerOrg]
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
