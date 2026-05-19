import { listTeamMembers } from "../../../../../../../../../src/memberships.js"
import { can, TEAM_ROLES } from "../../../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../../../src/utilities/responses.js"

/**
 * Lists a team's members as a table, each row with a collapsible role editor
 * and a remove button (shown when the caller may manage the team).
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
  const result = await listTeamMembers(context.data.dbClient!, team_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const base = `/api/db/auth/organisations/${encodeURIComponent(
    org_uuid
  )}/teams/${encodeURIComponent(team_uuid)}`
  const canEditRoles = can(teamRoles, "team:members:roles") || manage
  const canRemove = can(teamRoles, "team:members:remove") || manage

  let html =
    "<table><thead><tr><th>Member</th><th>Roles</th><th>Actions</th></tr></thead><tbody>"
  for (const member of result.members) {
    let actions = ""
    if (canEditRoles) {
      const checkboxes = TEAM_ROLES.map(
        (role) =>
          `<label><input type="checkbox" name="roles" value="${role}" ${
            member.roles.includes(role) ? "checked" : ""
          } /> ${role}</label>`
      ).join(" ")
      actions += `<details><summary>Edit roles</summary>
        <form hx-post="${base}/members/roles" hx-target="#team-message-area" hx-swap="innerHTML">
          <input type="hidden" name="user_uuid" value="${escapeHtml(member.user_uuid)}" />
          ${checkboxes}
          <button type="submit" class="btn-save">Save roles</button>
        </form></details>`
    }
    if (canRemove) {
      const removeVals = escapeHtml(
        JSON.stringify({ user_uuid: member.user_uuid })
      )
      actions += `<button class="btn-danger" hx-post="${base}/members/remove" hx-vals='${removeVals}' hx-target="#team-message-area" hx-swap="innerHTML" hx-confirm="Remove this member from the team?">Remove</button>`
    }
    html += `<tr>
      <td>${escapeHtml(member.user_name)}</td>
      <td>${escapeHtml(member.roles.join(", "))}</td>
      <td>${actions}</td>
    </tr>`
  }
  html += "</tbody></table>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
