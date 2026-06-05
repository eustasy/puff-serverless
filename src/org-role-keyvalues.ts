// Org-role-subject key/value store. KV rows attached to a (org_uuid, role)
// tuple — perms and metadata that apply to every user holding `role` in the
// org. Schema: sql/org_role_key_values.sql.

import { isOrgRole } from "./permissions.js"
import { createRoleKvModule, type KeyValueSpec } from "./utilities/role-keyvalues-shared.js"

const SPEC: KeyValueSpec = {
  table: "org_role_key_values",
  subjectColumns: ["org_uuid", "role"],
  selectColumns: "org_uuid, role, kv_key, kv_value, owner_user_uuid, owner_org_uuid, owner_app_uuid, owner_id, created_at, updated_at",
  label: "org-role-keyvalues",
}

export const { readKeyValue, readKeyValues, searchKeyValues, setKeyValue, deleteKeyValue } = createRoleKvModule<OrgRoleKeyValueRow>(
  SPEC,
  isOrgRole,
  "Unknown organisation role."
)
