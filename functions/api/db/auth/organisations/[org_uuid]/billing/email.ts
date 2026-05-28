import { setBillingEmailOverride } from "../../../../../../../src/billing.js"
import { createStripeProvider } from "../../../../../../../src/billing-stripe.js"
import { can } from "../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../src/utilities/escape.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../../../src/utilities/responses.js"

/**
 * Sets or clears the org's billing-email override and syncs it to the payment
 * provider. Requires `org:billing:write`. Requires the org to already have a
 * billing customer (created on first subscribe). An empty `email` clears the
 * override and falls back to the resolved billing-role contact.
 *
 * Form fields:
 *   email — the override address, or empty to clear it.
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:write")) {
    return resultNegative("You do not have permission to manage billing.", 403)
  }

  const formData = await context.request.formData()
  const emailRaw = formData.get("email")
  const email = typeof emailRaw === "string" ? emailRaw.trim() : ""

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)

  let provider
  try {
    provider = createStripeProvider(context.env)
  } catch {
    return resultNegative("Billing is not configured.", 500)
  }

  const result = await setBillingEmailOverride(dbClient, provider, {
    org_uuid,
    email: email || null,
  })
  if (result.error) {
    return resultNegative("Could not update the billing email.", result.status)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  return resultPositive(
    result.email
      ? `Billing email set to ${escapeHtml(result.email)}.`
      : "Billing email cleared; falling back to the organisation's billing contact.",
    200
  )
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
