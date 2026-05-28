import {
  getSubscription,
  updateSubscription,
  type ProrationBehavior,
} from "../../../../../../../../../src/billing.js"
import { createStripeProvider } from "../../../../../../../../../src/billing-stripe.js"
import { can } from "../../../../../../../../../src/permissions.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../../src/hooks/events.js"

/**
 * Updates the tier (price) of a subscription. Validates that the subscription
 * belongs to this organisation before mutating — prevents an admin of org A
 * from mutating org B's subscription.
 *
 * Form fields:
 *   tier        — required; the new tier name.
 *   proration   — optional; pass "always_invoice" to charge immediately.
 */
export const onRequestPost: Handler<"org_uuid" | "subscription_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:write")) {
    return resultNegative("You do not have permission to manage billing.", 403)
  }

  const formData = await context.request.formData()
  const tier = formData.get("tier")
  const prorationRaw = formData.get("proration")

  if (typeof tier !== "string" || !tier.trim()) {
    return resultNegative("tier is required.", 400)
  }

  const prorationBehavior: ProrationBehavior =
    prorationRaw === "always_invoice" ? "always_invoice" : "create_prorations"

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)
  const subscription_uuid = String(context.params.subscription_uuid)

  // Ownership check: verify the subscription belongs to this org before acting.
  const existing = await getSubscription(dbClient, subscription_uuid)
  if (existing.error) {
    return resultNegative("Could not load subscription.", 500)
  }
  if (!existing.success || !existing.subscription) {
    // Return 404, not 403, to avoid leaking the existence of another org's sub.
    return resultNegative("Subscription not found.", 404)
  }
  if (existing.subscription.org_uuid !== org_uuid) {
    return resultNegative("Subscription not found.", 404)
  }

  let provider
  try {
    provider = createStripeProvider(context.env)
  } catch {
    return resultNegative("Billing is not configured.", 500)
  }

  const result = await updateSubscription(dbClient, provider, {
    subscription_uuid,
    newTier: tier.trim(),
    prorationBehavior,
  })
  if (result.error) {
    return resultNegative("Could not update subscription.", result.status)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  await emitFromContext(context, {
    event_type: EVENTS.BILLING_SUBSCRIPTION_UPDATED,
    target_org_uuid: org_uuid,
    event_metadata: { subscription_uuid, tier: tier.trim(), prorationBehavior },
  })

  return resultPositive("Subscription updated.", 200)
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
