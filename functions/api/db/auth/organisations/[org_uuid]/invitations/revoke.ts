import { revokeInvitation } from "../../../../../../../src/invitations.js"
import { can } from "../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"

/** Revokes a pending invitation. */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:invite")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let token = ""
  try {
    const formData = await context.request.formData()
    token = String(formData.get("token") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (!token) {
    return resultNegative("An invitation is required.", 400)
  }

  const result = await revokeInvitation(
    context.data.dbClient!,
    String(context.params.org_uuid),
    token
  )
  if (!result.success) {
    return resultNegative(
      result.error
        ? "Could not revoke the invitation."
        : "Invitation not found.",
      result.status
    )
  }
  return resultPositive("Invitation revoked.", result.status, {
    "HX-Trigger": "organisationInvitationsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
