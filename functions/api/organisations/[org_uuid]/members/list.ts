import { listOrgMembers } from "../../../../../src/memberships.js"
import { can, ORG_ROLES } from "../../../../../src/permissions.js"
import { renderMembersTable } from "../../../../../src/utilities/members-endpoint.js"
import { resultNegative, methodNotAllowed } from "../../../../../src/utilities/responses.js"

export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await listOrgMembers(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const base = `/api/organisations/${encodeURIComponent(org_uuid)}`
  return renderMembersTable(result.members, {
    roles: ORG_ROLES,
    base,
    messageArea: "org-message-area",
    confirmMessage: "Remove this member from the organisation?",
    canEditRoles: can(orgRoles, "org:members:roles"),
    canRemove: can(orgRoles, "org:members:remove"),
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
