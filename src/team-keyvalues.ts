// Team-subject key/value store. KV rows attached to a `teams.team_uuid`,
// owned by a user or an organisation. Schema: sql/team_key_values.sql.

import {
  KeyValueSpec,
  Owner,
  deleteKeyValueGeneric,
  readKeyValueGeneric,
  readKeyValuesGeneric,
  searchKeyValuesGeneric,
  upsertKeyValue,
} from "./utilities/keyvalues-shared.js"

const SPEC: KeyValueSpec = {
  table: "team_key_values",
  subjectColumns: ["team_uuid"],
  selectColumns: "team_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "team-keyvalues",
}

/** Reads a single value for (team, owner, key). */
export const readKeyValue = (dbClient: DbClient, team_uuid: string, owner: Owner, key: string) =>
  readKeyValueGeneric(dbClient, SPEC, [team_uuid], owner, key)

/** Reads every (key, value) row a single owner has stored against a team. */
export const readKeyValues = (dbClient: DbClient, team_uuid: string, owner: Owner) =>
  readKeyValuesGeneric<TeamKeyValueRow>(dbClient, SPEC, [team_uuid], owner)

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (dbClient: DbClient, team_uuid: string, owner: Owner, pattern: string) =>
  searchKeyValuesGeneric<TeamKeyValueRow>(dbClient, SPEC, [team_uuid], owner, pattern)

/** Upsert (create or replace) a value for (team, owner, key). */
export const setKeyValue = (dbClient: DbClient, team_uuid: string, owner: Owner, key: string, value: string) =>
  upsertKeyValue(dbClient, SPEC.table, SPEC.subjectColumns, [team_uuid], owner, key, value)

/** Removes (team, owner, key); 404 if no such row. */
export const deleteKeyValue = (dbClient: DbClient, team_uuid: string, owner: Owner, key: string) =>
  deleteKeyValueGeneric(dbClient, SPEC, [team_uuid], owner, key)
