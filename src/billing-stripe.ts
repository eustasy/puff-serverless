// Stripe adapter for the billing domain (Phase 9). Implements `BillingProvider`
// from `billing.ts` against the Stripe REST API using the native `fetch`
// (same rationale as `mailer.ts`: a plain HTTPS client bundles cleanly for
// Workers with no Node-oriented SDK dependency). Configuration:
//   STRIPE_SECRET_KEY               (secret) — API key, sent as a Bearer token.
//   STRIPE_WEBHOOK_SIGNING_SECRET   (secret) — used by the webhook verifier.
//
// Adapter methods THROW on error (transport failure or a non-2xx response);
// the domain layer in `billing.ts` catches and maps to an error envelope. This
// keeps the provider interface returning plain DTOs and makes a fake provider
// trivial to write in tests.

import type { BillingProvider, ProviderCheckoutSession, ProviderCustomer, ProviderSubscription, SubscriptionStatus } from "./billing.js"

const STRIPE_API_BASE = "https://api.stripe.com"
// Pin the API version so response shapes are stable across Stripe upgrades.
const STRIPE_API_VERSION = "2024-06-20"
const REQUEST_TIMEOUT_MS = 15000

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string
  ) {
    super(message)
    this.name = "StripeError"
  }
}

// Flattens an object into Stripe's bracketed form-encoding, e.g.
// { items: [{ price: "p" }], metadata: { a: "b" } } ->
// items[0][price]=p&metadata[a]=b. null/undefined values are dropped.
// Exported for unit testing the encoding.
export function encodeForm(data: Record<string, unknown>): string {
  const params = new URLSearchParams()
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(`${key}[${index}]`, item))
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        add(`${key}[${k}]`, v)
      }
    } else {
      params.append(key, String(value))
    }
  }
  for (const [k, v] of Object.entries(data)) add(k, v)
  return params.toString()
}

async function stripeRequest(
  secret: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${secret}`,
    "Stripe-Version": STRIPE_API_VERSION,
  }
  let encoded: string | undefined
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    encoded = encodeForm(body)
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey

  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers,
    body: encoded,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const err = (json.error ?? {}) as { message?: string; type?: string }
    throw new StripeError(err.message ?? `Stripe HTTP ${response.status}`, response.status, err.type)
  }
  return json
}

// Stripe subscription statuses -> our constrained set. `unpaid` is treated as
// past_due (still recoverable); `incomplete_expired` collapses to incomplete.
function mapStatus(stripeStatus: unknown): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "paused":
    case "incomplete":
      return stripeStatus
    case "unpaid":
      return "past_due"
    case "incomplete_expired":
      return "incomplete"
    default:
      return "incomplete"
  }
}

function unixToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null
}

// Maps a raw Stripe Subscription object to our normalised shape. Exported so
// the webhook handler can reuse the same field mapping.
export function mapStripeSubscription(raw: Record<string, unknown>): ProviderSubscription {
  return {
    id: String(raw.id),
    status: mapStatus(raw.status),
    current_period_start: unixToDate(raw.current_period_start) ?? new Date(0),
    current_period_end: unixToDate(raw.current_period_end) ?? new Date(0),
    trial_end: unixToDate(raw.trial_end),
    cancel_at: unixToDate(raw.cancel_at),
    canceled_at: unixToDate(raw.canceled_at),
  }
}

// --- Webhook signature verification ---------------------------------------

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Constant-time comparison of two equal-purpose hex strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Verifies a Stripe webhook signature header of the form
 * `t=<unix>,v1=<hex>[,v1=<hex>...]`. Recomputes HMAC-SHA256 over
 * `${t}.${payload}` with the signing secret and compares (constant-time)
 * against each provided `v1`, rejecting if the timestamp is outside tolerance.
 */
export async function verifyStripeSignature(input: {
  payload: string
  signatureHeader: string | null
  signingSecret: string
  toleranceSeconds?: number
}): Promise<boolean> {
  const { payload, signatureHeader, signingSecret } = input
  const tolerance = input.toleranceSeconds ?? 300
  if (!signatureHeader || !signingSecret) return false

  let timestamp: string | null = null
  const signatures: string[] = []
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") timestamp = value
    else if (key === "v1") signatures.push(value)
  }
  if (!timestamp || signatures.length === 0) return false

  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`))
  const expected = bufferToHex(signed)
  return signatures.some((sig) => timingSafeEqual(expected, sig))
}

/**
 * Builds a `BillingProvider` backed by Stripe. Throws if the secret key is not
 * configured, so the caller fails fast rather than making unauthenticated
 * requests.
 */
export function createStripeProvider(env: Env): BillingProvider {
  const secret = env.STRIPE_SECRET_KEY
  if (!secret) {
    throw new StripeError("STRIPE_SECRET_KEY is not configured.", 500)
  }
  const signingSecret = env.STRIPE_WEBHOOK_SIGNING_SECRET ?? ""

  return {
    name: "stripe",

    async createCustomer(input): Promise<ProviderCustomer> {
      const body: Record<string, unknown> = { metadata: input.metadata }
      if (input.email) body.email = input.email
      if (input.name) body.name = input.name
      if (input.locale) body.preferred_locales = [input.locale]
      const raw = await stripeRequest(secret, "POST", "/v1/customers", body, input.idempotencyKey)
      return { id: String(raw.id) }
    },

    async updateCustomer(providerCustomerId, input): Promise<void> {
      // Stripe clears the email when sent empty; send a space-collapsed value
      // or empty string explicitly so a cleared override propagates.
      await stripeRequest(secret, "POST", `/v1/customers/${encodeURIComponent(providerCustomerId)}`, { email: input.email ?? "" })
    },

    async createSubscription(input): Promise<ProviderSubscription> {
      const body: Record<string, unknown> = {
        customer: input.customerId,
        items: [{ price: input.priceId }],
        metadata: input.metadata,
      }
      if (input.trialDays && input.trialDays > 0) {
        body.trial_period_days = input.trialDays
      }
      const raw = await stripeRequest(secret, "POST", "/v1/subscriptions", body, input.idempotencyKey)
      return mapStripeSubscription(raw)
    },

    async updateSubscription(providerSubscriptionId, input): Promise<ProviderSubscription> {
      const body: Record<string, unknown> = {
        proration_behavior: input.prorationBehavior,
      }
      // Changing the price requires the existing subscription item id, so
      // read the subscription first and swap that item to the new price.
      if (input.priceId) {
        const current = await stripeRequest(secret, "GET", `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`)
        const items = (current.items ?? {}) as {
          data?: Array<{ id?: string }>
        }
        const itemId = items.data?.[0]?.id
        body.items = [{ id: itemId, price: input.priceId }]
      }
      const raw = await stripeRequest(secret, "POST", `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, body)
      return mapStripeSubscription(raw)
    },

    async cancelSubscription(providerSubscriptionId, input): Promise<ProviderSubscription> {
      const encoded = encodeURIComponent(providerSubscriptionId)
      const raw = input.immediately
        ? await stripeRequest(secret, "DELETE", `/v1/subscriptions/${encoded}`)
        : await stripeRequest(secret, "POST", `/v1/subscriptions/${encoded}`, {
            cancel_at_period_end: true,
          })
      return mapStripeSubscription(raw)
    },

    async createCheckoutSession(input): Promise<ProviderCheckoutSession> {
      // Mirror the metadata onto `subscription_data` so the subscription
      // object created by checkout carries org_uuid/app_uuid/tier — the
      // webhook reads it from the subscription, not the checkout session.
      const subscriptionData: Record<string, unknown> = {
        metadata: input.metadata,
      }
      if (input.trialDays && input.trialDays > 0) {
        subscriptionData.trial_period_days = input.trialDays
      }
      const body: Record<string, unknown> = {
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        subscription_data: subscriptionData,
      }
      const raw = await stripeRequest(secret, "POST", "/v1/checkout/sessions", body)
      return { id: String(raw.id), url: String(raw.url) }
    },

    async createBillingPortalSession(input): Promise<{ url: string }> {
      const raw = await stripeRequest(secret, "POST", "/v1/billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      })
      return { url: String(raw.url) }
    },

    async recordMeterEvent(input): Promise<void> {
      const body: Record<string, unknown> = {
        event_name: input.eventName,
        identifier: input.identifier,
        payload: {
          stripe_customer_id: input.customerId,
          value: String(input.value),
        },
      }
      if (input.timestamp) body.timestamp = input.timestamp
      // Idempotency-Key header + meter-event `identifier` both guard retries.
      await stripeRequest(secret, "POST", "/v1/billing/meter_events", body, input.identifier)
    },

    verifyWebhookSignature(input) {
      return verifyStripeSignature({
        ...input,
        signingSecret: input.signingSecret || signingSecret,
      })
    },
  }
}
