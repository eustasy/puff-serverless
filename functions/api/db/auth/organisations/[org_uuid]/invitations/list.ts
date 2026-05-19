import { listInvitations } from "../../../../../../../src/invitations.js"
import { can } from "../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"

/** Lists an organisation's pending invitations as an HTML table fragment. */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:invite")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const result = await listInvitations(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  if (result.invitations.length === 0) {
    return htmlResponse("<p>No pending invitations.</p>")
  }

  let html =
    "<table><thead><tr><th>Email</th><th>Roles</th><th>Expires</th></tr></thead><tbody>"
  for (const invitation of result.invitations) {
    html += `<tr>
      <td>${escapeHtml(invitation.email_address)}</td>
      <td>${escapeHtml(invitation.roles.join(", "))}</td>
      <td>${escapeHtml(new Date(invitation.expires_at).toISOString())}</td>
    </tr>`
  }
  html += "</tbody></table>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
