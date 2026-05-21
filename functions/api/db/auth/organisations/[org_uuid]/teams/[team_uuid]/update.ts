import { updateTeam } from "../../../../../../../../src/teams.js"
import { can } from "../../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../src/hooks/events.js"

/** Updates a team's name. */
export const onRequestPost: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:update") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let name = ""
  try {
    const formData = await context.request.formData()
    name = String(formData.get("name") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }

  const result = await updateTeam(
    context.data.dbClient!,
    String(context.params.team_uuid),
    name
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_UPDATED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: String(context.params.team_uuid),
    target_label: name,
  })
  return resultPositive("Team updated.", result.status, {
    "HX-Trigger": "teamsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
