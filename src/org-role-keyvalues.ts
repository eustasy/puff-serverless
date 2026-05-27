// Org-role-subject key/value store. KV rows attached to a (org_uuid, role)
// tuple — perms and metadata that apply to every user holding `role` in the
// org. Schema: sql/org_role_key_values.sql.

import { isOrgRole } from "./permissions.js"
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
  table: "org_role_key_values",
  subjectColumns: ["org_uuid", "role"],
  selectColumns:
    "org_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "org-role-keyvalues",
}

const ROLE_ERROR = {
  success: false,
  message: "Unknown organisation role.",
  status: 400,
} as const

function rejectInvalidRole(role: string): typeof ROLE_ERROR | null {
  return isOrgRole(role) ? null : ROLE_ERROR
}

/** Reads a single value for (org, role, owner, key). */
export const readKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{ value: string }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return readKeyValueGeneric(dbClient, SPEC, [org_uuid, role], owner, key)
}

/** Reads every (key, value) row for an org+role under a single owner. */
export const readKeyValues = (
  dbClient: DbClient,
  org_uuid: string,
  role: string,
  owner: Owner
): Promise<Envelope<{ pairs: OrgRoleKeyValueRow[] }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return readKeyValuesGeneric<OrgRoleKeyValueRow>(
    dbClient,
    SPEC,
    [org_uuid, role],
    owner
  )
}

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (
  dbClient: DbClient,
  org_uuid: string,
  role: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: OrgRoleKeyValueRow[] }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return searchKeyValuesGeneric<OrgRoleKeyValueRow>(
    dbClient,
    SPEC,
    [org_uuid, role],
    owner,
    pattern
  )
}

/** Upsert (create or replace) a value for (org, role, owner, key). */
export const setKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  role: string,
  owner: Owner,
  key: string,
  value: string
): Promise<Envelope<{ created: boolean }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return upsertKeyValue(
    dbClient,
    SPEC.table,
    SPEC.subjectColumns,
    [org_uuid, role],
    owner,
    key,
    value
  )
}

/** Removes (org, role, owner, key); 404 if no such row. */
export const deleteKeyValue = (
  dbClient: DbClient,
  org_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{}>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return deleteKeyValueGeneric(dbClient, SPEC, [org_uuid, role], owner, key)
}
