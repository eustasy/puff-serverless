// Billing domain module (Phase 9). Provider-agnostic entry points over the
// `billing_customers`, `subscriptions`, `invoices` and `billing_pricing`
// tables. Every function takes `dbClient` first and returns the canonical
// envelope — none throw.
//
// Split of responsibility:
//   - This module owns the DATABASE side: it reads/writes the local billing
//     rows and is the source of truth for entitlement state.
//   - A `BillingProvider` adapter (see `billing-stripe.ts`) owns the PAYMENT
//     RAIL: customer/subscription/checkout objects at Stripe. The adapter is
//     injected as a parameter so the provider is swappable and so tests can
//     pass a fake. Adapter methods THROW on failure; the domain functions here
//     catch and map to a `502` error envelope. The webhook handler
//     (`billing-webhook.ts`) is the layer that synchronises provider state
//     back into these rows.

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "paused",
  "incomplete",
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

// Statuses under which an app counts as licensed. Payment-up-front, zero
// grace: only `active` and `trialing` are entitled. See `entitlements.ts`.
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
]

// --- Provider adapter interface -------------------------------------------

export interface ProviderCustomer {
  id: string
}

export interface ProviderSubscription {
  id: string
  status: SubscriptionStatus
  current_period_start: Date
  current_period_end: Date
  trial_end: Date | null
  cancel_at: Date | null
  canceled_at: Date | null
}

export interface ProviderCheckoutSession {
  id: string
  url: string
}

export type ProrationBehavior = "create_prorations" | "always_invoice" | "none"

/**
 * The payment-rail operations the billing domain needs. Implemented by a
 * concrete adapter (`createStripeProvider(env)`); methods throw on transport
 * or provider error and the domain layer maps that to an error envelope.
 */
export interface BillingProvider {
  /** Stored verbatim in the `provider` column (e.g. `"stripe"`). */
  readonly name: string

  createCustomer(input: {
    email: string | null
    name: string | null
    locale: string | null
    metadata?: Record<string, string>
    idempotencyKey?: string
  }): Promise<ProviderCustomer>

  /** Updates mutable fields on an existing provider customer (e.g. the email). */
  updateCustomer(
    providerCustomerId: string,
    input: { email: string | null }
  ): Promise<void>

  createSubscription(input: {
    customerId: string
    priceId: string
    trialDays?: number | null
    metadata?: Record<string, string>
    idempotencyKey?: string
  }): Promise<ProviderSubscription>

  updateSubscription(
    providerSubscriptionId: string,
    input: {
      priceId?: string
      prorationBehavior?: ProrationBehavior
    }
  ): Promise<ProviderSubscription>

  cancelSubscription(
    providerSubscriptionId: string,
    input: { immediately: boolean }
  ): Promise<ProviderSubscription>

  createCheckoutSession(input: {
    customerId: string
    priceId: string
    trialDays?: number | null
    successUrl: string
    cancelUrl: string
    metadata?: Record<string, string>
  }): Promise<ProviderCheckoutSession>

  /**
   * Creates a provider-hosted customer portal session for self-serve payment
   * method / billing management, returning the URL to redirect the user to.
   */
  createBillingPortalSession(input: {
    customerId: string
    returnUrl: string
  }): Promise<{ url: string }>

  /**
   * Reports a usage total to the provider's metering API. `identifier` makes
   * the call idempotent so a retried rollup sync does not double-bill.
   */
  recordMeterEvent(input: {
    eventName: string
    customerId: string
    value: number
    identifier: string
    timestamp?: number
  }): Promise<void>

  /**
   * Verifies a webhook payload against the signature header using the signing
   * secret. Returns a boolean only; the caller parses the (now-trusted) JSON.
   */
  verifyWebhookSignature(input: {
    payload: string
    signatureHeader: string | null
    signingSecret: string
    toleranceSeconds?: number
  }): Promise<boolean>
}

// --- Column lists ----------------------------------------------------------

const CUSTOMER_COLUMNS =
  "org_uuid, provider, provider_customer_id, default_payment_method_id, tax_id, billing_email, synced_email"

const SUBSCRIPTION_COLUMNS =
  "subscription_uuid, org_uuid, app_uuid, provider, provider_subscription_id, status, tier, current_period_start, current_period_end, cancel_at, canceled_at, trial_end, created_at"

const INVOICE_COLUMNS =
  "invoice_uuid, org_uuid, subscription_uuid, provider, provider_invoice_id, status, amount_cents, currency, period_start, period_end, due_at, paid_at, hosted_invoice_url, created_at"

const PRICING_COLUMNS =
  "pricing_uuid, app_uuid, tier, price_cents, currency, billing_interval, provider_price_id"

// The error-only envelope variant, assignable to any `Envelope<T>`.
type ErrorEnvelope = {
  error: true
  message: string
  details?: unknown
  status: number
}

// Maps a thrown adapter error to the canonical 502 envelope.
function providerError(fn: string, error: unknown): ErrorEnvelope {
  console.error(`Error in ${fn} (provider):`, error)
  return {
    error: true,
    message: "The payment provider could not complete the request.",
    details: error instanceof Error ? error.message : String(error),
    status: 502,
  }
}

// --- Pricing catalog -------------------------------------------------------

/** All pricing rows for an app, cheapest interval first then tier name. */
export async function listPricing(
  dbClient: DbClient,
  app_uuid: string
): Promise<Envelope<{ pricing: BillingPricingRow[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${PRICING_COLUMNS} FROM billing_pricing
        WHERE app_uuid = $1 ORDER BY tier ASC`,
      [app_uuid]
    )
    return { success: true, pricing: rows, status: 200 }
  } catch (error) {
    console.error("Error in listPricing:", error)
    return {
      error: true,
      message: "Could not list pricing.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** The pricing row for a single `(app, tier)`, or null when none is defined. */
export async function getPricing(
  dbClient: DbClient,
  app_uuid: string,
  tier: string
): Promise<Envelope<{ pricing: BillingPricingRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${PRICING_COLUMNS} FROM billing_pricing
        WHERE app_uuid = $1 AND tier = $2 LIMIT 1`,
      [app_uuid, tier]
    )
    return { success: true, pricing: rows[0] ?? null, status: 200 }
  } catch (error) {
    console.error("Error in getPricing:", error)
    return {
      error: true,
      message: "Could not read pricing.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Customers -------------------------------------------------------------

/**
 * Resolves the org's billing-contact email from its membership, used when no
 * explicit `billing_customers.billing_email` override is set. Ranks members
 * who hold a verified primary email by role:
 *   1. billing only (the dedicated finance contact)
 *   2. billing + owner
 *   3. billing + admin
 *   4. any billing-role holder
 *   5. owner (final fallback, even without the billing role)
 * Tiebreak: earliest membership, then email. Returns null if nobody qualifies.
 * Members without a verified primary email are skipped so the result is always
 * a deliverable address.
 */
export async function resolveBillingEmail(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ email: string | null }>> {
  try {
    const { rows } = await dbClient.query(
      `WITH member_roles AS (
         SELECT user_uuid, array_agg(role) AS roles, min(added_at) AS first_added
           FROM organisation_members
          WHERE org_uuid = $1
          GROUP BY user_uuid
       ),
       ranked AS (
         SELECT user_uuid, first_added,
           CASE
             WHEN 'billing' = ALL(roles) THEN 1
             WHEN 'billing' = ANY(roles) AND 'owner' = ANY(roles) THEN 2
             WHEN 'billing' = ANY(roles) AND 'admin' = ANY(roles) THEN 3
             WHEN 'billing' = ANY(roles) THEN 4
             WHEN 'owner' = ANY(roles) THEN 5
             ELSE NULL
           END AS tier
           FROM member_roles
       )
       SELECT e.email_address
         FROM ranked r
         JOIN emails e ON e.user_uuid = r.user_uuid
                      AND e.is_primary = TRUE AND e.is_verified = TRUE
        WHERE r.tier IS NOT NULL
        ORDER BY r.tier ASC, r.first_added ASC, e.email_address ASC
        LIMIT 1`,
      [org_uuid]
    )
    return { success: true, email: rows[0]?.email_address ?? null, status: 200 }
  } catch (error) {
    console.error("Error in resolveBillingEmail:", error)
    return {
      error: true,
      message: "Could not resolve billing email.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** The billing-customer row for an org, or null if the org has none yet. */
export async function getCustomer(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ customer: BillingCustomerRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM billing_customers
        WHERE org_uuid = $1 LIMIT 1`,
      [org_uuid]
    )
    return { success: true, customer: rows[0] ?? null, status: 200 }
  } catch (error) {
    console.error("Error in getCustomer:", error)
    return {
      error: true,
      message: "Could not read billing customer.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Returns the org's billing customer, creating one at the provider (and the
 * local row) if it does not exist. Idempotent: a concurrent insert is resolved
 * by re-reading the winning row. A lost race can leave an orphaned provider
 * customer — logged for operator cleanup, never surfaced as an error.
 */
export async function ensureCustomer(
  dbClient: DbClient,
  provider: BillingProvider,
  input: {
    org_uuid: string
    org_name: string | null
    locale: string | null
  }
): Promise<Envelope<{ customer: BillingCustomerRow }>> {
  try {
    const existing = await getCustomer(dbClient, input.org_uuid)
    if (!existing.success) return existing
    if (existing.customer) {
      return { success: true, customer: existing.customer, status: 200 }
    }

    // No override exists before the row does, so the effective email is the
    // resolved billing-contact from membership.
    const resolved = await resolveBillingEmail(dbClient, input.org_uuid)
    if (!resolved.success) return resolved
    const effective = resolved.email

    let created: ProviderCustomer
    try {
      created = await provider.createCustomer({
        email: effective,
        name: input.org_name,
        locale: input.locale,
        metadata: { org_uuid: input.org_uuid },
        idempotencyKey: `customer:${input.org_uuid}`,
      })
    } catch (error) {
      return providerError("ensureCustomer", error)
    }

    const { rows } = await dbClient.query(
      `INSERT INTO billing_customers
         (org_uuid, provider, provider_customer_id, synced_email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_uuid) DO NOTHING
       RETURNING ${CUSTOMER_COLUMNS}`,
      [input.org_uuid, provider.name, created.id, effective]
    )
    if (rows.length > 0) {
      return { success: true, customer: rows[0], status: 201 }
    }

    // Lost a race: another request inserted first. Our provider customer is
    // now orphaned — log it and return the row that won.
    console.error(
      `ensureCustomer: race for org ${input.org_uuid}; orphaned provider customer ${created.id}.`
    )
    const winner = await getCustomer(dbClient, input.org_uuid)
    if (!winner.success) return winner
    if (!winner.customer) {
      return {
        error: true,
        message: "Could not load billing customer after insert.",
        status: 500,
      }
    }
    return { success: true, customer: winner.customer, status: 200 }
  } catch (error) {
    console.error("Error in ensureCustomer:", error)
    return {
      error: true,
      message: "Could not ensure billing customer.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Sets (or clears) the operator override for an org's billing email and syncs
 * the effective address to the provider. Pass `null`/empty to clear the
 * override and fall back to `resolveBillingEmail`. Requires an existing billing
 * customer. Pushes to the provider only when the effective email drifts from
 * `synced_email`.
 */
export async function setBillingEmailOverride(
  dbClient: DbClient,
  provider: BillingProvider,
  input: { org_uuid: string; email: string | null }
): Promise<Envelope<{ email: string | null }>> {
  try {
    const customerRes = await getCustomer(dbClient, input.org_uuid)
    if (!customerRes.success) return customerRes
    if (!customerRes.customer) {
      return {
        success: false,
        message: "This organisation has no billing set up yet.",
        status: 400,
      }
    }
    const customer = customerRes.customer
    const override =
      input.email && input.email.trim() ? input.email.trim() : null

    let effective: string | null = override
    if (!effective) {
      const resolved = await resolveBillingEmail(dbClient, input.org_uuid)
      if (!resolved.success) return resolved
      effective = resolved.email
    }

    await dbClient.query(
      `UPDATE billing_customers SET billing_email = $2 WHERE org_uuid = $1`,
      [input.org_uuid, override]
    )

    if (effective !== customer.synced_email) {
      try {
        await provider.updateCustomer(customer.provider_customer_id, {
          email: effective,
        })
      } catch (error) {
        return providerError("setBillingEmailOverride", error)
      }
      await dbClient.query(
        `UPDATE billing_customers SET synced_email = $2 WHERE org_uuid = $1`,
        [input.org_uuid, effective]
      )
    }

    return { success: true, email: effective, status: 200 }
  } catch (error) {
    console.error("Error in setBillingEmailOverride:", error)
    return {
      error: true,
      message: "Could not set billing email.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reconciles every billing customer's provider email against the current
 * effective address (`billing_email` override ?? `resolveBillingEmail`),
 * pushing to the provider only on drift and recording the new `synced_email`.
 * Run hourly from `src/cron.ts`. A single customer's failure is logged and
 * skipped so the rest still reconcile. Returns the count actually updated.
 */
export async function reconcileBillingEmails(
  dbClient: DbClient,
  provider: BillingProvider,
  opts: { limit?: number } = {}
): Promise<Envelope<{ reconciled: number }>> {
  const limit = opts.limit ?? 1000
  try {
    const { rows } = await dbClient.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM billing_customers
        ORDER BY org_uuid ASC LIMIT $1`,
      [limit]
    )
    let reconciled = 0
    for (const customer of rows as BillingCustomerRow[]) {
      let effective: string | null = customer.billing_email
      if (!effective) {
        const resolved = await resolveBillingEmail(dbClient, customer.org_uuid)
        if (!resolved.success) continue
        effective = resolved.email
      }
      if (effective === customer.synced_email) continue
      try {
        await provider.updateCustomer(customer.provider_customer_id, {
          email: effective,
        })
        await dbClient.query(
          `UPDATE billing_customers SET synced_email = $2 WHERE org_uuid = $1`,
          [customer.org_uuid, effective]
        )
        reconciled++
      } catch (error) {
        console.error(
          `reconcileBillingEmails: failed for org ${customer.org_uuid}:`,
          error
        )
      }
    }
    return { success: true, reconciled, status: 200 }
  } catch (error) {
    console.error("Error in reconcileBillingEmails:", error)
    return {
      error: true,
      message: "Could not reconcile billing emails.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Subscriptions ---------------------------------------------------------

/** All subscriptions for an org, newest first. */
export async function listSubscriptions(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ subscriptions: SubscriptionRow[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE org_uuid = $1 ORDER BY created_at DESC`,
      [org_uuid]
    )
    return { success: true, subscriptions: rows, status: 200 }
  } catch (error) {
    console.error("Error in listSubscriptions:", error)
    return {
      error: true,
      message: "Could not list subscriptions.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

export type OperatorSubscriptionRow = SubscriptionRow & {
  org_name: string
  app_name: string
}

/**
 * Operator view: every subscription across all orgs, newest first, with the
 * org and app names joined in for display. Paged. For the admin dashboard.
 */
export async function listAllSubscriptions(
  dbClient: DbClient,
  opts: { limit?: number; offset?: number } = {}
): Promise<Envelope<{ subscriptions: OperatorSubscriptionRow[] }>> {
  const limit = opts.limit ?? 200
  const offset = opts.offset ?? 0
  try {
    const { rows } = await dbClient.query(
      `SELECT s.subscription_uuid, s.org_uuid, s.app_uuid, s.provider,
              s.provider_subscription_id, s.status, s.tier,
              s.current_period_start, s.current_period_end, s.cancel_at,
              s.canceled_at, s.trial_end, s.created_at,
              o.org_name, a.app_name
         FROM subscriptions s
         JOIN organisations o ON o.org_uuid = s.org_uuid
         JOIN apps a ON a.app_uuid = s.app_uuid
        ORDER BY s.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    return { success: true, subscriptions: rows, status: 200 }
  } catch (error) {
    console.error("Error in listAllSubscriptions:", error)
    return {
      error: true,
      message: "Could not list subscriptions.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** A single subscription by uuid, or null. */
export async function getSubscription(
  dbClient: DbClient,
  subscription_uuid: string
): Promise<Envelope<{ subscription: SubscriptionRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE subscription_uuid = $1 LIMIT 1`,
      [subscription_uuid]
    )
    return { success: true, subscription: rows[0] ?? null, status: 200 }
  } catch (error) {
    console.error("Error in getSubscription:", error)
    return {
      error: true,
      message: "Could not read subscription.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * The org's subscription for one app (there is at most one — UNIQUE on
 * `(org_uuid, app_uuid)`), or null. This is the row `isLicensed` consults.
 */
export async function getSubscriptionForApp(
  dbClient: DbClient,
  org_uuid: string,
  app_uuid: string
): Promise<Envelope<{ subscription: SubscriptionRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE org_uuid = $1 AND app_uuid = $2 LIMIT 1`,
      [org_uuid, app_uuid]
    )
    return { success: true, subscription: rows[0] ?? null, status: 200 }
  } catch (error) {
    console.error("Error in getSubscriptionForApp:", error)
    return {
      error: true,
      message: "Could not read subscription.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Creates a subscription directly at the provider and records the local row.
 * Used where a payment method already exists (operator/comp flows, or after
 * checkout capture). Self-serve signup goes through `startSubscriptionCheckout`
 * instead, where the row is created later by the webhook.
 *
 * `tier` must resolve to a `billing_pricing` row for the app. Returns a 409 if
 * the org already has a subscription for this app.
 */
export async function createSubscription(
  dbClient: DbClient,
  provider: BillingProvider,
  input: {
    org_uuid: string
    app_uuid: string
    tier: string
    customerId: string
    trialDays?: number | null
  }
): Promise<Envelope<{ subscription: SubscriptionRow }>> {
  try {
    const existing = await getSubscriptionForApp(
      dbClient,
      input.org_uuid,
      input.app_uuid
    )
    if (!existing.success) return existing
    if (existing.subscription) {
      return {
        success: false,
        message: "This organisation already has a subscription for that app.",
        status: 409,
      }
    }

    const priced = await getPricing(dbClient, input.app_uuid, input.tier)
    if (!priced.success) return priced
    if (!priced.pricing) {
      return {
        success: false,
        message: "No pricing is configured for that tier.",
        status: 400,
      }
    }

    let sub: ProviderSubscription
    try {
      sub = await provider.createSubscription({
        customerId: input.customerId,
        priceId: priced.pricing.provider_price_id,
        trialDays: input.trialDays,
        metadata: { org_uuid: input.org_uuid, app_uuid: input.app_uuid },
        idempotencyKey: `sub:${input.org_uuid}:${input.app_uuid}`,
      })
    } catch (error) {
      return providerError("createSubscription", error)
    }

    const { rows } = await dbClient.query(
      `INSERT INTO subscriptions
         (subscription_uuid, org_uuid, app_uuid, provider, provider_subscription_id,
          status, tier, current_period_start, current_period_end,
          cancel_at, canceled_at, trial_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        crypto.randomUUID(),
        input.org_uuid,
        input.app_uuid,
        provider.name,
        sub.id,
        sub.status,
        input.tier,
        sub.current_period_start,
        sub.current_period_end,
        sub.cancel_at,
        sub.canceled_at,
        sub.trial_end,
      ]
    )
    return { success: true, subscription: rows[0], status: 201 }
  } catch (error) {
    console.error("Error in createSubscription:", error)
    return {
      error: true,
      message: "Could not create subscription.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Changes a subscription's tier (price), with proration semantics chosen by
 * the caller. `prorationBehavior` defaults to the provider's standard
 * `create_prorations`; pass `always_invoice` to charge the upgrade
 * immediately (the "charge now on upgrade" option exposed in the org UI).
 */
export async function updateSubscription(
  dbClient: DbClient,
  provider: BillingProvider,
  input: {
    subscription_uuid: string
    newTier: string
    prorationBehavior?: ProrationBehavior
  }
): Promise<Envelope<{ subscription: SubscriptionRow }>> {
  try {
    const current = await getSubscription(dbClient, input.subscription_uuid)
    if (!current.success) return current
    if (!current.subscription) {
      return { success: false, message: "Subscription not found.", status: 404 }
    }
    const row = current.subscription

    const priced = await getPricing(dbClient, row.app_uuid, input.newTier)
    if (!priced.success) return priced
    if (!priced.pricing) {
      return {
        success: false,
        message: "No pricing is configured for that tier.",
        status: 400,
      }
    }

    let sub: ProviderSubscription
    try {
      sub = await provider.updateSubscription(row.provider_subscription_id, {
        priceId: priced.pricing.provider_price_id,
        prorationBehavior: input.prorationBehavior,
      })
    } catch (error) {
      return providerError("updateSubscription", error)
    }

    const { rows } = await dbClient.query(
      `UPDATE subscriptions
          SET tier = $1, status = $2, current_period_start = $3,
              current_period_end = $4, cancel_at = $5, canceled_at = $6,
              trial_end = $7
        WHERE subscription_uuid = $8
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        input.newTier,
        sub.status,
        sub.current_period_start,
        sub.current_period_end,
        sub.cancel_at,
        sub.canceled_at,
        sub.trial_end,
        input.subscription_uuid,
      ]
    )
    return { success: true, subscription: rows[0], status: 200 }
  } catch (error) {
    console.error("Error in updateSubscription:", error)
    return {
      error: true,
      message: "Could not update subscription.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Cancels a subscription, immediately or at period end. Immediate cancellation
 * flips `status` to `canceled` now; end-of-period leaves it active with
 * `cancel_at` set and lets the webhook flip the status when the period closes.
 */
export async function cancelSubscription(
  dbClient: DbClient,
  provider: BillingProvider,
  input: { subscription_uuid: string; immediately: boolean }
): Promise<Envelope<{ subscription: SubscriptionRow }>> {
  try {
    const current = await getSubscription(dbClient, input.subscription_uuid)
    if (!current.success) return current
    if (!current.subscription) {
      return { success: false, message: "Subscription not found.", status: 404 }
    }
    const row = current.subscription

    let sub: ProviderSubscription
    try {
      sub = await provider.cancelSubscription(row.provider_subscription_id, {
        immediately: input.immediately,
      })
    } catch (error) {
      return providerError("cancelSubscription", error)
    }

    const { rows } = await dbClient.query(
      `UPDATE subscriptions
          SET status = $1, cancel_at = $2, canceled_at = $3
        WHERE subscription_uuid = $4
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [sub.status, sub.cancel_at, sub.canceled_at, input.subscription_uuid]
    )
    return { success: true, subscription: rows[0], status: 200 }
  } catch (error) {
    console.error("Error in cancelSubscription:", error)
    return {
      error: true,
      message: "Could not cancel subscription.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Begins a self-serve subscription by creating a provider-hosted checkout
 * session and returning its URL. The subscription row is NOT created here — it
 * is written when the resulting `checkout.session.completed` /
 * `customer.subscription.created` webhook arrives. Returns 409 if the org
 * already has a subscription for the app.
 */
export async function startSubscriptionCheckout(
  dbClient: DbClient,
  provider: BillingProvider,
  input: {
    org_uuid: string
    app_uuid: string
    tier: string
    customerId: string
    successUrl: string
    cancelUrl: string
    trialDays?: number | null
  }
): Promise<Envelope<{ checkoutUrl: string; sessionId: string }>> {
  try {
    const existing = await getSubscriptionForApp(
      dbClient,
      input.org_uuid,
      input.app_uuid
    )
    if (!existing.success) return existing
    if (existing.subscription) {
      return {
        success: false,
        message: "This organisation already has a subscription for that app.",
        status: 409,
      }
    }

    const priced = await getPricing(dbClient, input.app_uuid, input.tier)
    if (!priced.success) return priced
    if (!priced.pricing) {
      return {
        success: false,
        message: "No pricing is configured for that tier.",
        status: 400,
      }
    }

    let session: ProviderCheckoutSession
    try {
      session = await provider.createCheckoutSession({
        customerId: input.customerId,
        priceId: priced.pricing.provider_price_id,
        trialDays: input.trialDays,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        metadata: {
          org_uuid: input.org_uuid,
          app_uuid: input.app_uuid,
          tier: input.tier,
        },
      })
    } catch (error) {
      return providerError("startSubscriptionCheckout", error)
    }

    return {
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      status: 200,
    }
  } catch (error) {
    console.error("Error in startSubscriptionCheckout:", error)
    return {
      error: true,
      message: "Could not start checkout.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Returns a provider-hosted billing-portal URL for an org to manage its
 * payment methods and billing details. Requires an existing billing customer —
 * there is nothing to manage before the org has subscribed.
 */
export async function openBillingPortal(
  dbClient: DbClient,
  provider: BillingProvider,
  input: { org_uuid: string; returnUrl: string }
): Promise<Envelope<{ portalUrl: string }>> {
  try {
    const customer = await getCustomer(dbClient, input.org_uuid)
    if (!customer.success) return customer
    if (!customer.customer) {
      return {
        success: false,
        message: "This organisation has no billing set up yet.",
        status: 400,
      }
    }

    let session: { url: string }
    try {
      session = await provider.createBillingPortalSession({
        customerId: customer.customer.provider_customer_id,
        returnUrl: input.returnUrl,
      })
    } catch (error) {
      return providerError("openBillingPortal", error)
    }

    return { success: true, portalUrl: session.url, status: 200 }
  } catch (error) {
    console.error("Error in openBillingPortal:", error)
    return {
      error: true,
      message: "Could not open billing portal.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Invoices --------------------------------------------------------------

/** All invoices for an org, newest first. */
export async function listInvoices(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ invoices: InvoiceRow[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices
        WHERE org_uuid = $1 ORDER BY created_at DESC`,
      [org_uuid]
    )
    return { success: true, invoices: rows, status: 200 }
  } catch (error) {
    console.error("Error in listInvoices:", error)
    return {
      error: true,
      message: "Could not list invoices.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** A single invoice by uuid scoped to an org, or null. */
export async function getInvoice(
  dbClient: DbClient,
  org_uuid: string,
  invoice_uuid: string
): Promise<Envelope<{ invoice: InvoiceRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices
        WHERE org_uuid = $1 AND invoice_uuid = $2 LIMIT 1`,
      [org_uuid, invoice_uuid]
    )
    return { success: true, invoice: rows[0] ?? null, status: 200 }
  } catch (error) {
    console.error("Error in getInvoice:", error)
    return {
      error: true,
      message: "Could not read invoice.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
