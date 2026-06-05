import type { ScopeMember } from "../memberships.js"
import { escapeHtml } from "./escape.js"
import { htmlResponse } from "./responses.js"

export function renderMembersTable(
  members: ScopeMember[],
  options: {
    roles: readonly string[]
    base: string
    messageArea: string
    confirmMessage: string
    canEditRoles: boolean
    canRemove: boolean
  },
): Response {
  let html = "<table><thead><tr><th>Member</th><th>Roles</th><th>Actions</th></tr></thead><tbody>"
  for (const member of members) {
    let actions = ""
    if (options.canEditRoles) {
      const checkboxes = options.roles
        .map(
          (role) =>
            `<label><input type="checkbox" name="roles" value="${role}" ${member.roles.includes(role) ? "checked" : ""} /> ${role}</label>`,
        )
        .join(" ")
      actions += `<details><summary>Edit roles</summary>
        <form hx-post="${options.base}/members/roles" hx-target="#${options.messageArea}" hx-swap="innerHTML">
          <input type="hidden" name="user_uuid" value="${escapeHtml(member.user_uuid)}" />
          ${checkboxes}
          <button type="submit" class="btn-save">Save roles</button>
        </form></details>`
    }
    if (options.canRemove) {
      const removeVals = escapeHtml(JSON.stringify({ user_uuid: member.user_uuid }))
      actions += `<button class="btn-danger" hx-post="${options.base}/members/remove" hx-vals='${removeVals}' hx-target="#${options.messageArea}" hx-swap="innerHTML" hx-confirm="${options.confirmMessage}">Remove</button>`
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
