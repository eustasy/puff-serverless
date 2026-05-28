// Provider webhook receiver. POST-only. Authenticated entirely by the Stripe
// signature header — no user session, no app credentials. The raw request body
// must be read verbatim for signature verification (any reserialisation would
// change the bytes and break the HMAC).

import { methodNotAllowed } from "../../../src/utilities/responses.js"
import { verifyStripeSignature } from "../../../src/billing-stripe.js"
import {
  handleStripeWebhookEvent,
  type StripeEvent,
} from "../../../src/billing-webhook.js"

export const onRequestPost: Handler = async (context) => {
  const signingSecret = context.env.STRIPE_WEBHOOK_SIGNING_SECRET
  if (!signingSecret) {
    console.error(
      "billing webhook: STRIPE_WEBHOOK_SIGNING_SECRET is not configured."
    )
    return new Response("Webhook not configured.", { status: 503 })
  }

  const raw = await context.request.text()
  const verified = await verifyStripeSignature({
    payload: raw,
    signatureHeader: context.request.headers.get("stripe-signature"),
    signingSecret,
  })
  if (!verified) {
    return new Response("Invalid signature.", { status: 400 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(raw) as StripeEvent
  } catch {
    return new Response("Invalid payload.", { status: 400 })
  }

  const dbClient = context.data.dbClient!
  const result = await handleStripeWebhookEvent(dbClient, context, event)
  return new Response(null, { status: result.status })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
