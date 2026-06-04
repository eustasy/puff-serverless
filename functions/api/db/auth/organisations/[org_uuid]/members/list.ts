import { listOrgMembers } from "../../../../../../../src/memberships.js"
import { can, ORG_ROLES } from "../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../src/utilities/escape.js"
import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../../../../src/utilities/responses.js"

/**
 * Lists an organisation's members as a table. Each row carries a collapsible
 * role editor and a remove button, shown only when the caller's role permits.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await listOrgMembers(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const base = `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}`
  const canEditRoles = can(orgRoles, "org:members:roles")
  const canRemove = can(orgRoles, "org:members:remove")

  let html = "<table><thead><tr><th>Member</th><th>Roles</th><th>Actions</th></tr></thead><tbody>"
  for (const member of result.members) {
    let actions = ""
    if (canEditRoles) {
      const checkboxes = ORG_ROLES.map(
        (role) =>
          `<label><input type="checkbox" name="roles" value="${role}" ${member.roles.includes(role) ? "checked" : ""} /> ${role}</label>`
      ).join(" ")
      actions += `<details><summary>Edit roles</summary>
        <form hx-post="${base}/members/roles" hx-target="#org-message-area" hx-swap="innerHTML">
          <input type="hidden" name="user_uuid" value="${escapeHtml(member.user_uuid)}" />
          ${checkboxes}
          <button type="submit" class="btn-save">Save roles</button>
        </form></details>`
    }
    if (canRemove) {
      const removeVals = escapeHtml(JSON.stringify({ user_uuid: member.user_uuid }))
      actions += `<button class="btn-danger" hx-post="${base}/members/remove" hx-vals='${removeVals}' hx-target="#org-message-area" hx-swap="innerHTML" hx-confirm="Remove this member from the organisation?">Remove</button>`
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
