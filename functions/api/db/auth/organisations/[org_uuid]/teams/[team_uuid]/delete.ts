import { deleteTeam } from "../../../../../../../../src/teams.js"
import { can } from "../../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../src/hooks/events.js"

/** Permanently deletes a team; its membership rows cascade away. */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:delete") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const team_uuid = String(context.params.team_uuid)
  const result = await deleteTeam(context.data.dbClient!, team_uuid)
  if (!result.success) {
    return resultNegative(
      result.error ? "Could not delete the team." : "Team not found.",
      result.status
    )
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_DELETED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: team_uuid,
  })
  return resultPositive("Team deleted.", result.status, {
    "HX-Trigger": "teamsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
