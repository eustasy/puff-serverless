import { deleteTeam } from "../../../../../../../../src/teams.js"
import { can } from "../../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../src/utilities/responses.js"

/** Permanently deletes a team; its membership rows cascade away. */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:delete") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const result = await deleteTeam(
    context.data.dbClient!,
    String(context.params.team_uuid)
  )
  if (!result.success) {
    return resultNegative(
      result.error ? "Could not delete the team." : "Team not found.",
      result.status
    )
  }
  return resultPositive("Team deleted.", result.status, {
    "HX-Trigger": "teamsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
