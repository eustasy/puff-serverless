import { listTeams } from "../../../../../src/teams.js"
import { can } from "../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../../src/utilities/responses.js"

/**
 * Lists an organisation's teams. Each row's "Manage" button loads that team's
 * panel (see the team `read.ts`) into `#team-detail`.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await listTeams(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  if (result.teams.length === 0) {
    return htmlResponse("<p>This organisation has no teams yet.</p>")
  }

  const base = `/api/organisations/${encodeURIComponent(org_uuid)}/teams`
  let html = '<ul class="team-list">'
  for (const team of result.teams) {
    html += `<li>
      <strong>${escapeHtml(team.team_name)}</strong>
      <button
        class="btn-safe"
        hx-get="${base}/${encodeURIComponent(team.team_uuid)}/read"
        hx-target="#team-detail"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
      >Manage</button>
    </li>`
  }
  html += "</ul>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
