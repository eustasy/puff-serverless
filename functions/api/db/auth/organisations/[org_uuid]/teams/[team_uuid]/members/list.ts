import { listTeamMembers } from "../../../../../../../../../src/memberships.js"
import { can, TEAM_ROLES } from "../../../../../../../../../src/permissions.js"
import { renderMembersTable } from "../../../../../../../../../src/utilities/members-endpoint.js"
import { resultNegative, methodNotAllowed } from "../../../../../../../../../src/utilities/responses.js"

export const onRequestGet: Handler<"org_uuid" | "team_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  const manage = can(orgRoles, "org:teams:manage")
  if (!can(teamRoles, "team:view") && !manage) {
    return resultNegative("You do not have access to this team.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)
  const result = await listTeamMembers(context.data.dbClient!, team_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const base = `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}/teams/${encodeURIComponent(team_uuid)}`
  return renderMembersTable(result.members, {
    roles: TEAM_ROLES,
    base,
    messageArea: "team-message-area",
    confirmMessage: "Remove this member from the team?",
    canEditRoles: can(teamRoles, "team:members:roles") || manage,
    canRemove: can(teamRoles, "team:members:remove") || manage,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
