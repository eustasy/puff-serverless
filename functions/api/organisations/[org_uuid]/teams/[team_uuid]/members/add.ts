import { addTeamMember } from "../../../../../../../src/memberships.js"
import { getUserByEmail } from "../../../../../../../src/users.js"
import { can, DEFAULT_TEAM_ROLE } from "../../../../../../../src/permissions.js"
import { resultPositive, resultNegative, methodNotAllowed } from "../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../src/hooks/events.js"

/**
 * Adds an existing user to a team with a role (defaulting to `member`). The
 * user is identified by **email address** (`user_name` is a display name, not
 * a unique handle). A team grant alone makes the user a guest of the
 * organisation — organisation membership is not required.
 */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:members:add") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let formData: FormData
  try {
    formData = await context.request.formData()
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  const email = String(formData.get("email") ?? "").trim()
  const role = String(formData.get("role") ?? DEFAULT_TEAM_ROLE)
  if (!email) {
    return resultNegative("An email address is required.", 400)
  }

  const dbClient = context.data.dbClient!
  const user = await getUserByEmail(dbClient, email)
  if (user.error) {
    return resultNegative("Could not look up that user.", 500)
  }
  if (!user.success) {
    return resultNegative("No account found for that email address — send an invitation instead.", 404)
  }

  const result = await addTeamMember(dbClient, String(context.params.team_uuid), user.user_uuid, role, context.data.user_uuid!)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_MEMBER_ADDED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: String(context.params.team_uuid),
    target_user_uuid: user.user_uuid,
    target_label: role,
  })
  return resultPositive(`${user.user_name} added to the team.`, result.status, {
    "HX-Trigger": "teamMembersChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
