import { openBillingPortal } from "../../../../../../../../src/billing.js"
import { createStripeProvider } from "../../../../../../../../src/billing-stripe.js"
import { can } from "../../../../../../../../src/permissions.js"
import {
  methodNotAllowed,
  resultNegative,
} from "../../../../../../../../src/utilities/responses.js"

/**
 * Opens a Stripe-hosted billing portal session for this organisation and
 * redirects the user there. The portal lets users self-serve their payment
 * methods and billing details without us building individual add/remove/set-
 * default endpoints.
 *
 * Branches on `HX-Request` to send either an HTMX or standard browser redirect.
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:write")) {
    return resultNegative("You do not have permission to manage billing.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const appUrl = (context.env.APP_URL ?? "").replace(/\/+$/, "")
  const returnUrl = `${appUrl}/organisations/${org_uuid}/billing`

  let provider
  try {
    provider = createStripeProvider(context.env)
  } catch {
    return resultNegative("Billing is not configured.", 500)
  }

  const dbClient = context.data.dbClient!
  const result = await openBillingPortal(dbClient, provider, {
    org_uuid,
    returnUrl,
  })
  if (result.error) {
    return resultNegative("Could not open billing portal.", result.status)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const target = result.portalUrl
  const isHtmx = context.request.headers.get("HX-Request") === "true"
  return new Response(null, {
    status: 303,
    headers: isHtmx ? { "HX-Redirect": target } : { Location: target },
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
