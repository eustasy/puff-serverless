// User-subject key/value store. The serverless successor to the PHP server's
// `KeyValues` table — generalised here so any owner (a user themselves, or an
// organisation, and later a linked app) can attach key/value rows to a user.
//
// SQL schema: sql/user_key_values.sql. The composite primary key
// (user_uuid, owner_id, kv_key) makes the (subject, owner, key) triple
// unique — the owner is first-class, so app-owned and org-owned rows about
// the same user with the same key coexist.

import {
  KeyValueSpec,
  Owner,
  deleteKeyValueGeneric,
  readKeyValueGeneric,
  readKeyValuesGeneric,
  searchKeyValuesGeneric,
  upsertKeyValue,
} from "./utilities/keyvalues-shared.js"

export type { Owner } from "./utilities/keyvalues-shared.js"
export { MAX_KEY_LENGTH, MAX_VALUE_LENGTH, MAX_KEYS_PER_OWNER_SUBJECT } from "./utilities/keyvalues-shared.js"

const SPEC: KeyValueSpec = {
  table: "user_key_values",
  subjectColumns: ["user_uuid"],
  selectColumns: "user_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "user-keyvalues",
}

/** Reads a single value for (user, owner, key). */
export const readKeyValue = (dbClient: DbClient, user_uuid: string, owner: Owner, key: string) =>
  readKeyValueGeneric(dbClient, SPEC, [user_uuid], owner, key)

/** Reads every (key, value) row a single owner has stored against a user. */
export const readKeyValues = (dbClient: DbClient, user_uuid: string, owner: Owner) =>
  readKeyValuesGeneric<UserKeyValueRow>(dbClient, SPEC, [user_uuid], owner)

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (dbClient: DbClient, user_uuid: string, owner: Owner, pattern: string) =>
  searchKeyValuesGeneric<UserKeyValueRow>(dbClient, SPEC, [user_uuid], owner, pattern)

/** Upsert (create or replace) a value for (user, owner, key). */
export const setKeyValue = (dbClient: DbClient, user_uuid: string, owner: Owner, key: string, value: string) =>
  upsertKeyValue(dbClient, SPEC.table, SPEC.subjectColumns, [user_uuid], owner, key, value)

/** Removes (user, owner, key); 404 if no such row. */
export const deleteKeyValue = (dbClient: DbClient, user_uuid: string, owner: Owner, key: string) =>
  deleteKeyValueGeneric(dbClient, SPEC, [user_uuid], owner, key)
