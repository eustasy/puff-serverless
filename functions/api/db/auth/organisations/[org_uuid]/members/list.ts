import { listOrgMembers } from "../../../../../../../src/memberships.js"
import { can } from "../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"

/** Lists an organisation's members and their roles as an HTML table fragment. */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const result = await listOrgMembers(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  let html =
    "<table><thead><tr><th>Member</th><th>Roles</th></tr></thead><tbody>"
  for (const member of result.members) {
    html += `<tr>
      <td>${escapeHtml(member.user_name)}</td>
      <td>${escapeHtml(member.roles.join(", "))}</td>
    </tr>`
  }
  html += "</tbody></table>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
