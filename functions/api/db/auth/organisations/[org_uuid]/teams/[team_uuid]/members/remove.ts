import { removeTeamMember } from "../../../../../../../../../src/memberships.js"
import { can } from "../../../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../../src/hooks/events.js"

/** Removes a user from a team (every role they hold in it). */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (
    !can(teamRoles, "team:members:remove") &&
    !can(orgRoles, "org:teams:manage")
  ) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let user_uuid = ""
  try {
    const formData = await context.request.formData()
    user_uuid = String(formData.get("user_uuid") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (!user_uuid) {
    return resultNegative("A user is required.", 400)
  }

  const result = await removeTeamMember(
    context.data.dbClient!,
    String(context.params.team_uuid),
    user_uuid
  )
  if (!result.success) {
    return resultNegative(
      result.error ? "Could not remove the member." : result.message,
      result.status
    )
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_MEMBER_REMOVED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: String(context.params.team_uuid),
    target_user_uuid: user_uuid,
  })
  return resultPositive("Member removed.", result.status, {
    "HX-Trigger": "teamMembersChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
