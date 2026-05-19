import { readTeam } from "../../../../../../../../src/teams.js"
import { can } from "../../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../src/utilities/responses.js"

/** Returns a team's details as an HTML fragment. */
export const onRequestGet: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(teamRoles, "team:view") && !can(orgRoles, "org:teams:manage")) {
    return resultNegative("You do not have access to this team.", 403)
  }

  const result = await readTeam(
    context.data.dbClient!,
    String(context.params.team_uuid)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const team = result.team
  return htmlResponse(
    `<dl class="team-detail">
      <dt>Name</dt><dd>${escapeHtml(team.team_name)}</dd>
      <dt>URL slug</dt><dd>${escapeHtml(team.team_slug)}</dd>
    </dl>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
