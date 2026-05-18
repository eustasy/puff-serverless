// Per-user key/value store. Arbitrary string metadata keyed by (user_uuid,
// kv_key) — the serverless successor to the PHP server's `KeyValues` table and
// its `Puff_Member_Key_*` functions (create/value/update/destroy/like).
//
// SQL schema: sql/key_values.sql. The composite primary key
// (user_uuid, kv_key) both enforces one value per key per user and serves as
// the lookup index, so no secondary index is needed.
//
// Every helper takes `dbClient` first and returns the standard `Envelope`
// shape (see types.d.ts) — they never throw or return raw rows.

import { runInTransaction, Rollback } from "./utilities/transaction.js"

// Parity with the PHP `KeyValues.Key` column (varchar(128)).
export const MAX_KEY_LENGTH = 128
// The PHP value column was also varchar(128); widened here — "arbitrary
// per-user metadata" outgrows 128 characters quickly.
export const MAX_VALUE_LENGTH = 4096
// Soft abuse guard on the number of distinct keys a single user may hold.
export const MAX_KEYS_PER_USER = 256

/**
 * Validates a key/value pair against the length and emptiness rules.
 * @param {string} key - The key to validate.
 * @param {string} [value] - The value to validate; omit to validate the key only.
 * @returns {string | null} - An error message, or null when valid.
 */
function validatePair(key: string, value?: string): string | null {
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
 * Escapes the LIKE wildcards (`%`, `_`) and the escape character (`\`) in a
 * user-supplied pattern so it is matched as a literal substring.
 * @param {string} input - The raw pattern.
 * @returns {string} - The escaped pattern, safe to wrap in `%...%`.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Reads a single value for a user's key.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} key - The key to look up.
 * @returns {Promise<object>} - `{ success: true, value }`, `{ success: false }` when absent, or an error envelope.
 */
export async function readKeyValue(
  dbClient: DbClient,
  user_uuid: string,
  key: string
): Promise<Envelope<{ value: string }>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const result = await dbClient.query(
      "SELECT kv_value FROM key_values WHERE user_uuid = $1 AND kv_key = $2 LIMIT 1",
      [user_uuid, key]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, value: result.rows[0].kv_value, status: 200 }
  } catch (error) {
    console.error("Error in readKeyValue:", error)
    return {
      error: true,
      message: "Server error while reading key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reads every key/value pair for a user, ordered by key.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} - `{ success: true, pairs }` or an error envelope.
 */
export async function readKeyValues(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ pairs: KeyValueRow[] }>> {
  try {
    const result = await dbClient.query(
      "SELECT user_uuid, kv_key, kv_value, created_at, updated_at FROM key_values WHERE user_uuid = $1 ORDER BY kv_key ASC",
      [user_uuid]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in readKeyValues:", error)
    return {
      error: true,
      message: "Server error while reading key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Returns the user's key/value pairs whose key contains the given substring.
 * The serverless equivalent of the PHP `Puff_Member_Key_Like`; LIKE wildcards
 * in the input are escaped, so the match is always a literal substring.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} pattern - The substring to search keys for.
 * @returns {Promise<object>} - `{ success: true, pairs }` or an error envelope.
 */
export async function searchKeyValues(
  dbClient: DbClient,
  user_uuid: string,
  pattern: string
): Promise<Envelope<{ pairs: KeyValueRow[] }>> {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return {
      success: false,
      message: "A search term is required.",
      status: 400,
    }
  }
  try {
    const result = await dbClient.query(
      "SELECT user_uuid, kv_key, kv_value, created_at, updated_at FROM key_values WHERE user_uuid = $1 AND kv_key LIKE $2 ESCAPE '\\' ORDER BY kv_key ASC",
      [user_uuid, `%${escapeLikePattern(pattern)}%`]
    )
    return { success: true, pairs: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in searchKeyValues:", error)
    return {
      error: true,
      message: "Server error while searching key/values.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Creates or replaces a key/value pair for a user (upsert). New keys are
 * rejected once the per-user key limit is reached; updates to an existing key
 * are always allowed. Covers both PHP `Puff_Member_Key_Create` and `_Update`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} key - The key to set.
 * @param {string} value - The value to store.
 * @returns {Promise<object>} - `{ success: true, created }` where `created` is true for a new key, false for an update; or an error envelope.
 */
export async function setKeyValue(
  dbClient: DbClient,
  user_uuid: string,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> {
  const invalid = validatePair(key, value)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    // SERIALIZABLE isolation makes the count-check + insert race-free: a
    // concurrent insert that would push the key count past the limit forces a
    // serialization failure, which runInTransaction retries.
    type SetResult = Envelope<{ created: boolean }>
    return await runInTransaction(dbClient, async (): Promise<SetResult> => {
      const existing = await dbClient.query(
        "SELECT 1 FROM key_values WHERE user_uuid = $1 AND kv_key = $2 LIMIT 1",
        [user_uuid, key]
      )
      const isNewKey = (existing.rowCount ?? 0) === 0

      if (isNewKey) {
        const countResult = await dbClient.query(
          "SELECT count(*)::INT AS count FROM key_values WHERE user_uuid = $1",
          [user_uuid]
        )
        if (countResult.rows[0].count >= MAX_KEYS_PER_USER) {
          throw new Rollback<SetResult>({
            success: false,
            message: `You have reached the limit of ${MAX_KEYS_PER_USER} stored keys. Remove a key before adding another.`,
            status: 409,
          })
        }
      }

      // ON CONFLICT covers the race where a concurrent request inserts the
      // same key between the existence check and this statement.
      await dbClient.query(
        "INSERT INTO key_values (user_uuid, kv_key, kv_value) VALUES ($1, $2, $3) ON CONFLICT (user_uuid, kv_key) DO UPDATE SET kv_value = excluded.kv_value, updated_at = NOW()",
        [user_uuid, key, value]
      )
      return { success: true, created: isNewKey, status: isNewKey ? 201 : 200 }
    })
  } catch (error) {
    console.error("Error in setKeyValue:", error)
    return {
      error: true,
      message: "Server error while saving key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Deletes a key/value pair for a user.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} key - The key to delete.
 * @returns {Promise<object>} - `{ success: true }`, `{ success: false }` when the key does not exist, or an error envelope.
 */
export async function deleteKeyValue(
  dbClient: DbClient,
  user_uuid: string,
  key: string
): Promise<Envelope<{}>> {
  const invalid = validatePair(key)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const result = await dbClient.query(
      "DELETE FROM key_values WHERE user_uuid = $1 AND kv_key = $2",
      [user_uuid, key]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Key not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in deleteKeyValue:", error)
    return {
      error: true,
      message: "Server error while deleting key/value.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
