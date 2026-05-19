import { readTeam } from "../../../../../../../../src/teams.js"
import { can, TEAM_ROLES } from "../../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../src/utilities/responses.js"

/**
 * Renders a team's management panel — edit form, delete, and the members
 * sub-section — loaded into `#team-detail`. Controls appear when the caller
 * holds the team role or the organisation-level `org:teams:manage`.
 */
export const onRequestGet: Handler<"org_uuid" | "team_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  const manage = can(orgRoles, "org:teams:manage")
  if (!can(teamRoles, "team:view") && !manage) {
    return resultNegative("You do not have access to this team.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)
  const result = await readTeam(context.data.dbClient!, team_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  const team = result.team
  const base = `/api/db/auth/organisations/${encodeURIComponent(
    org_uuid
  )}/teams/${encodeURIComponent(team_uuid)}`
  const roleOptions = TEAM_ROLES.map(
    (role) => `<option value="${role}">${role}</option>`
  ).join("")

  let html = `<section class="team-panel">
  <h4>${escapeHtml(team.team_name)}</h4>
  <div id="team-message-area" class="result-area spacer-bottom"></div>`

  if (can(teamRoles, "team:update") || manage) {
    html += `
  <form hx-post="${base}/update" hx-target="#team-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Name:
      <input type="text" name="name" value="${escapeHtml(team.team_name)}" maxlength="128" required class="form-input" /></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Save</button></div>
  </form>`
  }
  if (can(teamRoles, "team:delete") || manage) {
    html += `
  <p><button class="btn-danger" hx-post="${base}/delete" hx-target="#team-message-area" hx-swap="innerHTML" hx-confirm="Delete this team?">Delete Team</button></p>`
  }

  html += `\n  <h5>Team members</h5>`
  if (can(teamRoles, "team:members:add") || manage) {
    html += `
  <form hx-post="${base}/members/add" hx-target="#team-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Email address:
      <input type="email" name="email" required class="form-input" /></label></div>
    <div class="grid-item"><label>Role:
      <select name="role" class="form-input">${roleOptions}</select></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Add</button></div>
  </form>`
  }
  html += `
  <div id="team-members" hx-get="${base}/members/list" hx-trigger="load, teamMembersChanged from:body" hx-swap="innerHTML"><p>Loading members...</p></div>
</section>`
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
