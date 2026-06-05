// Team-role-subject key/value store. KV rows attached to a (team_uuid, role)
// tuple — perms and metadata that apply to every user holding `role` in the
// team. Schema: sql/team_role_key_values.sql.

import { isTeamRole } from "./permissions.js"
import { createRoleKvModule, type KeyValueSpec } from "./utilities/role-keyvalues-shared.js"

const SPEC: KeyValueSpec = {
  table: "team_role_key_values",
  subjectColumns: ["team_uuid", "role"],
  selectColumns: "team_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "team-role-keyvalues",
}

export const { readKeyValue, readKeyValues, searchKeyValues, setKeyValue, deleteKeyValue } =
  createRoleKvModule<TeamRoleKeyValueRow>(SPEC, isTeamRole, "Unknown team role.")
