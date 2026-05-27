// Team-role-subject key/value store. KV rows attached to a (team_uuid, role)
// tuple — perms and metadata that apply to every user holding `role` in the
// team. Schema: sql/team_role_key_values.sql.

import { isTeamRole } from "./permissions.js"
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
  table: "team_role_key_values",
  subjectColumns: ["team_uuid", "role"],
  selectColumns:
    "team_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "team-role-keyvalues",
}

const ROLE_ERROR = {
  success: false,
  message: "Unknown team role.",
  status: 400,
} as const

function rejectInvalidRole(role: string): typeof ROLE_ERROR | null {
  return isTeamRole(role) ? null : ROLE_ERROR
}

/** Reads a single value for (team, role, owner, key). */
export const readKeyValue = (
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{ value: string }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return readKeyValueGeneric(dbClient, SPEC, [team_uuid, role], owner, key)
}

/** Reads every (key, value) row for a team+role under a single owner. */
export const readKeyValues = (
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner
): Promise<Envelope<{ pairs: TeamRoleKeyValueRow[] }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return readKeyValuesGeneric<TeamRoleKeyValueRow>(
    dbClient,
    SPEC,
    [team_uuid, role],
    owner
  )
}

/** Substring-matches keys (LIKE wildcards in `pattern` are escaped). */
export const searchKeyValues = (
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  pattern: string
): Promise<Envelope<{ pairs: TeamRoleKeyValueRow[] }>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return searchKeyValuesGeneric<TeamRoleKeyValueRow>(
    dbClient,
    SPEC,
    [team_uuid, role],
    owner,
    pattern
  )
}

/** Upsert (create or replace) a value for (team, role, owner, key). */
export const setKeyValue = (
  dbClient: DbClient,
  team_uuid: string,
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
    [team_uuid, role],
    owner,
    key,
    value
  )
}

/** Removes (team, role, owner, key); 404 if no such row. */
export const deleteKeyValue = (
  dbClient: DbClient,
  team_uuid: string,
  role: string,
  owner: Owner,
  key: string
): Promise<Envelope<{}>> => {
  const rejected = rejectInvalidRole(role)
  if (rejected) return Promise.resolve(rejected)
  return deleteKeyValueGeneric(dbClient, SPEC, [team_uuid, role], owner, key)
}
