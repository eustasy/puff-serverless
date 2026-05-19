import { listTeams } from "../../../../../../../src/teams.js"
import { can } from "../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"

/** Lists an organisation's teams as an HTML fragment. */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const result = await listTeams(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  if (result.teams.length === 0) {
    return htmlResponse("<p>This organisation has no teams yet.</p>")
  }

  let html = '<ul class="team-list">'
  for (const team of result.teams) {
    html += `<li data-team-uuid="${escapeHtml(team.team_uuid)}">
      <strong>${escapeHtml(team.team_name)}</strong>
    </li>`
  }
  html += "</ul>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
