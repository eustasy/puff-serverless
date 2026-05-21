import { acceptInvitation } from "../../../../../../src/invitations.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../src/hooks/events.js"

/**
 * Accepts an organisation invitation for the authenticated user. The session
 * (required by the `auth` middleware) identifies who joins; the token carries
 * the organisation and the roles. A new invitee registers first, then reaches
 * this endpoint with the same token.
 *
 * This route sits beside `[org_uuid]/`, not under it — the accepting user is
 * not yet a member, so the organisation `_middleware.ts` must not gate it.
 */
export const onRequestPost: Handler = async (context) => {
  let token = ""
  try {
    const formData = await context.request.formData()
    token = String(formData.get("token") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (!token) {
    return resultNegative("An invitation token is required.", 400)
  }

  const result = await acceptInvitation(
    context.data.dbClient!,
    token,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(
      result.error ? "Could not accept the invitation." : result.message,
      result.status
    )
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_INVITATION_ACCEPTED,
    target_org_uuid: result.org_uuid,
    target_user_uuid: context.data.user_uuid!,
  })
  return resultPositive("You have joined the organisation.", result.status, {
    "HX-Trigger": "organisationsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
