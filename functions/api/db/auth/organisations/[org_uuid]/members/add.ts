import { addOrgMember } from "../../../../../../../src/memberships.js"
import { getUserByEmail } from "../../../../../../../src/users.js"
import { can, DEFAULT_ORG_ROLE } from "../../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../src/hooks/events.js"

/**
 * Adds an existing user to an organisation with a role (defaulting to
 * `member`). The user is identified by **email address** — `user_name` is a
 * display name, not a unique handle. Adding someone who has no account yet is
 * the separate email-invitation flow (Phase 6 "Member invitations").
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:members:invite")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let formData: FormData
  try {
    formData = await context.request.formData()
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  const email = String(formData.get("email") ?? "").trim()
  const role = String(formData.get("role") ?? DEFAULT_ORG_ROLE)
  if (!email) {
    return resultNegative("An email address is required.", 400)
  }

  const dbClient = context.data.dbClient!
  const user = await getUserByEmail(dbClient, email)
  if (user.error) {
    return resultNegative("Could not look up that user.", 500)
  }
  if (!user.success) {
    return resultNegative(
      "No account found for that email address — send an invitation instead.",
      404
    )
  }

  const result = await addOrgMember(
    dbClient,
    String(context.params.org_uuid),
    user.user_uuid,
    role,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_MEMBER_ADDED,
    target_org_uuid: String(context.params.org_uuid),
    target_user_uuid: user.user_uuid,
    target_label: role,
  })
  return resultPositive(
    `${user.user_name} added to the organisation.`,
    result.status,
    { "HX-Trigger": "organisationMembersChanged" }
  )
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
