import { createInvitation } from "../../../../../../../src/invitations.js"
import { readOrganisation } from "../../../../../../../src/organisations.js"
import { sendOrganisationInvitationEmail } from "../../../../../../../src/mailer.js"
import { can, DEFAULT_ORG_ROLE } from "../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"

/**
 * Invites a person to the organisation by email. Works whether or not they
 * already have an account — the emailed link carries a single-use token they
 * accept after signing in or registering.
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:invite")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let email = ""
  let roles: string[] = []
  try {
    const formData = await context.request.formData()
    email = String(formData.get("email") ?? "").trim()
    roles = formData
      .getAll("roles")
      .filter((value): value is string => typeof value === "string")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  if (roles.length === 0) {
    roles = [DEFAULT_ORG_ROLE]
  }

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)

  const invitation = await createInvitation(
    dbClient,
    org_uuid,
    email,
    roles,
    context.data.user_uuid!
  )
  if (!invitation.success) {
    return resultNegative(invitation.message, invitation.status)
  }

  // The organisation name personalises the email.
  const org = await readOrganisation(dbClient, org_uuid)
  const orgName = org.success ? org.organisation.org_name : "an organisation"

  const sent = await sendOrganisationInvitationEmail(
    context.env,
    email,
    invitation.invitation.invitation_token,
    orgName
  )
  if (!sent.success) {
    // The invitation row exists; it can be revoked and re-sent.
    return resultNegative(
      "The invitation was created but the email could not be delivered.",
      502,
      { "HX-Trigger": "organisationInvitationsChanged" }
    )
  }
  return resultPositive(`Invitation sent to ${email}.`, 201, {
    "HX-Trigger": "organisationInvitationsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
