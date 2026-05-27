// Organisation-subject key/value store. KV rows attached to an
// `organisations.org_uuid`, owned by a user or another organisation.
// Schema: sql/organisation_key_values.sql.

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
  table: "organisation_key_values",
  subjectColumns: ["org_uuid"],
  selectColumns:
    "org_uuid, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "organisation-keyvalues",
}

/** Reads a single value for (org, owner, key). */
export const readKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string
) => readKeyValueGeneric(dbClient, SPEC, [org_uuid], owner, key)

/** Reads every (key, value) row a single owner has stored against an organisation. */
export const readKeyValues = (
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner
) =>
  readKeyValuesGeneric<OrganisationKeyValueRow>(
    dbClient,
    SPEC,
    [org_uuid],
    owner
  )

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  pattern: string
) =>
  searchKeyValuesGeneric<OrganisationKeyValueRow>(
    dbClient,
    SPEC,
    [org_uuid],
    owner,
    pattern
  )

/** Upsert (create or replace) a value for (org, owner, key). */
export const setKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string,
  value: string
) =>
  upsertKeyValue(
    dbClient,
    SPEC.table,
    SPEC.subjectColumns,
    [org_uuid],
    owner,
    key,
    value
  )

/** Removes (org, owner, key); 404 if no such row. */
export const deleteKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  owner: Owner,
  key: string
) => deleteKeyValueGeneric(dbClient, SPEC, [org_uuid], owner, key)
