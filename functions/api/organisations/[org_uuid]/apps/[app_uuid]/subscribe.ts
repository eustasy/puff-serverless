import { ensureCustomer, startSubscriptionCheckout } from "../../../../../../src/billing.js"
import { createStripeProvider } from "../../../../../../src/billing-stripe.js"
import { readOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import { methodNotAllowed, resultNegative } from "../../../../../../src/utilities/responses.js"

/**
 * Begins a self-serve subscription checkout for an app. Creates (or reuses) a
 * billing customer for the org, then redirects to a Stripe-hosted checkout
 * session. The subscription row is NOT created here — it is written when the
 * `checkout.session.completed` webhook arrives.
 *
 * Form fields:
 *   tier — required; the pricing tier to subscribe to.
 */
export const onRequestPost: Handler<"org_uuid" | "app_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:write")) {
    return resultNegative("You do not have permission to manage billing.", 403)
  }

  const formData = await context.request.formData()
  const tier = formData.get("tier")
  if (typeof tier !== "string" || !tier.trim()) {
    return resultNegative("tier is required.", 400)
  }

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)
  const app_uuid = String(context.params.app_uuid)

  // Resolve the app: prefer the middleware-resolved row, fall back to a DB read.
  const app = context.data.app
  if (!app) {
    return resultNegative("App not found.", 404)
  }

  // Load the org to get billing name and locale for customer creation.
  const orgResult = await readOrganisation(dbClient, org_uuid)
  if (orgResult.error) {
    return resultNegative("Could not load organisation.", 500)
  }
  if (!orgResult.success) {
    return resultNegative(orgResult.message, orgResult.status)
  }
  const org = orgResult.organisation

  let provider
  try {
    provider = createStripeProvider(context.env)
  } catch {
    return resultNegative("Billing is not configured.", 500)
  }

  const customerResult = await ensureCustomer(dbClient, provider, {
    org_uuid,
    org_name: org.org_name,
    locale: org.org_locale ?? null,
  })
  if (customerResult.error) {
    return resultNegative("Could not set up billing customer.", customerResult.status)
  }
  if (!customerResult.success) {
    return resultNegative(customerResult.message, customerResult.status)
  }

  const appUrl = (context.env.APP_URL ?? "").replace(/\/+$/, "")
  const successUrl = `${appUrl}/organisations/${org_uuid}/billing?subscribed=1`
  const cancelUrl = `${appUrl}/organisations/${org_uuid}/billing?canceled=1`

  const checkoutResult = await startSubscriptionCheckout(dbClient, provider, {
    org_uuid,
    app_uuid,
    tier: tier.trim(),
    customerId: customerResult.customer.provider_customer_id,
    successUrl,
    cancelUrl,
    trialDays: app.app_default_trial_days ?? null,
  })
  if (checkoutResult.error) {
    return resultNegative("Could not start checkout.", checkoutResult.status)
  }
  if (!checkoutResult.success) {
    return resultNegative(checkoutResult.message, checkoutResult.status)
  }

  const target = checkoutResult.checkoutUrl
  const isHtmx = context.request.headers.get("HX-Request") === "true"
  return new Response(null, {
    status: 303,
    headers: isHtmx ? { "HX-Redirect": target } : { Location: target },
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
