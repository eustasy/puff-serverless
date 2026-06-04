import { createTeam } from "../../../../../../../src/teams.js"
import { can } from "../../../../../../../src/permissions.js"
import { resultPositive, resultNegative, methodNotAllowed } from "../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../src/hooks/events.js"

/** Creates a team within the organisation. */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:teams:create")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let name = ""
  try {
    const formData = await context.request.formData()
    name = String(formData.get("name") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }

  const result = await createTeam(context.data.dbClient!, String(context.params.org_uuid), name)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_CREATED,
    target_org_uuid: String(context.params.org_uuid),
    target_team_uuid: result.team.team_uuid,
    target_label: result.team.team_name,
  })
  return resultPositive(`Team "${result.team.team_name}" created.`, result.status, { "HX-Trigger": "teamsChanged" })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
