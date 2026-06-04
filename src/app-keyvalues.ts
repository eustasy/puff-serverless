// App-subject key/value store. KV rows attached to an `apps.app_uuid`, owned
// by a user / organisation / app. Schema: sql/app_key_values.sql.
//
// Conceptually this is the **app tier** of the inheritance chain — when the
// resolver walks user → team-role → org-role → team → org → app and no
// earlier tier hits, the app's own globally-applied defaults (rows where
// `app_uuid` and `owner_app_uuid` are the same app) are the final fallback.

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
  table: "app_key_values",
  subjectColumns: ["app_uuid"],
  selectColumns: "app_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "app-keyvalues",
}

/** Reads a single value for (app, owner, key). */
export const readKeyValue = (dbClient: DbClient, app_uuid: string, owner: Owner, key: string) =>
  readKeyValueGeneric(dbClient, SPEC, [app_uuid], owner, key)

/** Reads every (key, value) row a single owner has stored against an app. */
export const readKeyValues = (dbClient: DbClient, app_uuid: string, owner: Owner) =>
  readKeyValuesGeneric<AppKeyValueRow>(dbClient, SPEC, [app_uuid], owner)

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (dbClient: DbClient, app_uuid: string, owner: Owner, pattern: string) =>
  searchKeyValuesGeneric<AppKeyValueRow>(dbClient, SPEC, [app_uuid], owner, pattern)

/** Upsert (create or replace) a value for (app, owner, key). */
export const setKeyValue = (dbClient: DbClient, app_uuid: string, owner: Owner, key: string, value: string) =>
  upsertKeyValue(dbClient, SPEC.table, SPEC.subjectColumns, [app_uuid], owner, key, value)

/** Removes (app, owner, key); 404 if no such row. */
export const deleteKeyValue = (dbClient: DbClient, app_uuid: string, owner: Owner, key: string) =>
  deleteKeyValueGeneric(dbClient, SPEC, [app_uuid], owner, key)
