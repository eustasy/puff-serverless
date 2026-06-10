import { listInvitations } from "../../../../../src/invitations.js"
import { can } from "../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../../src/utilities/responses.js"

/** Lists an organisation's pending invitations, each with a revoke button. */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:invite")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await listInvitations(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  if (result.invitations.length === 0) {
    return htmlResponse("<p>No pending invitations.</p>")
  }

  const base = `/api/organisations/${encodeURIComponent(org_uuid)}`
  let html = "<table><thead><tr><th>Email</th><th>Roles</th><th>Expires</th><th>Actions</th></tr></thead><tbody>"
  for (const invitation of result.invitations) {
    const revokeVals = escapeHtml(JSON.stringify({ token: invitation.invitation_token }))
    html += `<tr>
      <td>${escapeHtml(invitation.email_address)}</td>
      <td>${escapeHtml(invitation.roles.join(", "))}</td>
      <td>${escapeHtml(new Date(invitation.expires_at).toISOString())}</td>
      <td>
        <button
          class="btn-danger"
          hx-post="${base}/invitations/revoke"
          hx-vals='${revokeVals}'
          hx-target="#org-message-area"
          hx-swap="innerHTML"
          hx-confirm="Revoke this invitation?"
        >Revoke</button>
      </td>
    </tr>`
  }
  html += "</tbody></table>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
