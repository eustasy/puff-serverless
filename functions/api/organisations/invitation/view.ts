import { readInvitation } from "../../../../src/invitations.js"
import { escapeHtml } from "../../../../src/utilities/escape.js"
import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../src/utilities/responses.js"

/**
 * Previews an invitation from its token — the organisation name and the roles
 * offered — so the accept page can show what is being joined. Unauthenticated:
 * the recipient has not necessarily signed in yet. Possession of the token is
 * the capability.
 */
export const onRequestGet: Handler = async (context) => {
  const token = new URL(context.request.url).searchParams.get("token") ?? ""
  if (!token) {
    return resultNegative("No invitation token provided.", 400)
  }

  const result = await readInvitation(context.data.dbClient!, token)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const invitation = result.invitation
  if (invitation.is_used) {
    return resultNegative("This invitation has already been used.", 410)
  }
  if (new Date(invitation.expires_at).getTime() <= Date.now()) {
    return resultNegative("This invitation has expired.", 410)
  }

  return htmlResponse(
    `<div class="invitation-preview">
      <p>You have been invited to join
        <strong>${escapeHtml(invitation.org_name)}</strong>
        as ${escapeHtml(invitation.roles.join(", "))}.</p>
    </div>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
