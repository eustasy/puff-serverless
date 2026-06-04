import { setTeamMemberRoles } from "../../../../../../../../../src/memberships.js"
import { can } from "../../../../../../../../../src/permissions.js"
import { resultPositive, resultNegative, methodNotAllowed } from "../../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../../src/hooks/events.js"

/**
 * Replaces a member's team role set. Roles are submitted as repeated `roles`
 * form fields.
 */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:members:roles") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let user_uuid = ""
  let roles: string[] = []
  try {
    const formData = await context.request.formData()
    user_uuid = String(formData.get("user_uuid") ?? "")
    roles = formData.getAll("roles").filter((value): value is string => typeof value === "string")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (!user_uuid) {
    return resultNegative("A user is required.", 400)
  }

  const result = await setTeamMemberRoles(
    context.data.dbClient!,
    String(context.params.team_uuid),
    user_uuid,
    roles,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(result.error ? "Could not update the member's roles." : result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_MEMBER_ROLES_CHANGED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: String(context.params.team_uuid),
    target_user_uuid: user_uuid,
    event_metadata: { roles },
  })
  return resultPositive("Member roles updated.", result.status, {
    "HX-Trigger": "teamMembersChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
