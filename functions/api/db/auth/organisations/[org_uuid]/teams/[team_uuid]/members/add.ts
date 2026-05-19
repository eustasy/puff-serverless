import { addTeamMember } from "../../../../../../../../../src/memberships.js"
import { getUserByUsernameOrEmail } from "../../../../../../../../../src/passkeys.js"
import {
  can,
  DEFAULT_TEAM_ROLE,
} from "../../../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../../src/utilities/responses.js"

/**
 * Adds an existing user to a team with a role (defaulting to `member`). The
 * user is identified by username or email address. A team grant alone makes
 * the user a guest of the organisation — organisation membership is not
 * required.
 */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (
    !can(teamRoles, "team:members:add") &&
    !can(orgRoles, "org:teams:manage")
  ) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let identifier = ""
  let role: string = DEFAULT_TEAM_ROLE
  try {
    const formData = await context.request.formData()
    identifier = String(formData.get("identifier") ?? "").trim()
    role = String(formData.get("role") ?? DEFAULT_TEAM_ROLE)
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (!identifier) {
    return resultNegative("A username or email address is required.", 400)
  }

  const dbClient = context.data.dbClient!
  const user = await getUserByUsernameOrEmail(dbClient, identifier)
  if (user.error) {
    return resultNegative("Could not look up that user.", 500)
  }
  if (!user.success) {
    return resultNegative(
      "No account found for that username or email address.",
      404
    )
  }

  const result = await addTeamMember(
    dbClient,
    String(context.params.team_uuid),
    user.user_uuid,
    role,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(`${user.user_name} added to the team.`, result.status, {
    "HX-Trigger": "teamMembersChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
