import { getSubscription, cancelSubscription } from "../../../../../../../src/billing.js"
import { createStripeProvider } from "../../../../../../../src/billing-stripe.js"
import { can } from "../../../../../../../src/permissions.js"
import { methodNotAllowed, resultNegative, resultPositive } from "../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../src/hooks/events.js"

/**
 * Cancels a subscription. Validates that the subscription belongs to this
 * organisation before mutating — prevents cross-org mutation.
 *
 * Form fields:
 *   immediately — optional; pass "true" to cancel immediately rather than at
 *                 the end of the current billing period.
 */
export const onRequestPost: Handler<"org_uuid" | "subscription_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:write")) {
    return resultNegative("You do not have permission to manage billing.", 403)
  }

  const formData = await context.request.formData()
  const immediatelyRaw = formData.get("immediately")
  const immediately = immediatelyRaw === "true"

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

  const result = await cancelSubscription(dbClient, provider, {
    subscription_uuid,
    immediately,
  })
  if (result.error) {
    return resultNegative("Could not cancel subscription.", result.status)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  await emitFromContext(context, {
    event_type: EVENTS.BILLING_SUBSCRIPTION_CANCELED,
    target_org_uuid: org_uuid,
    event_metadata: { subscription_uuid, immediately },
  })

  return resultPositive(
    immediately ? "Subscription cancelled immediately." : "Subscription will cancel at the end of the current billing period.",
    200
  )
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
