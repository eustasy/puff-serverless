// Billing webhook synchroniser (Phase 9). Processes inbound provider webhook
// events and brings the local `subscriptions` / `invoices` rows in line with
// the payment provider, which is the source of truth for billing state.
//
// Idempotency / replay safety: Stripe retries an event (same `id`) for up to
// three days. Each event is recorded once in `billing_webhook_events`; a
// replay is detected by the unique `(provider, provider_event_id)` key and
// acked without reprocessing. The dedup insert and the state change run in one
// transaction, so a processing failure rolls back the dedup row too and the
// retry is honoured rather than silently dropped.
//
// Signature verification happens in the endpoint (`functions/api/billing/
// webhook.ts`) before this runs — by the time an event reaches here it is
// trusted.

import { Rollback, runInTransaction } from "./utilities/transaction.js"
import { emit } from "./hooks/dispatch.js"
import { EVENTS, type EventType } from "./hooks/events.js"
import type { EmitContext } from "./hooks/types.js"
import { mapStripeSubscription } from "./billing-stripe.js"

const PROVIDER = "stripe"

export interface StripeEvent {
  id?: string
  type?: string
  data?: { object?: Record<string, unknown> }
}

function unixToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000)
    : null
}

function metadataOf(object: Record<string, unknown>): Record<string, string> {
  const m = object.metadata
  return m && typeof m === "object" ? (m as Record<string, string>) : {}
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Processes one already-verified webhook event. Returns the HTTP status the
 * endpoint should reply with: 200 for handled (or a deduped replay), 400 for a
 * malformed event, 500 for a processing failure (so the provider retries).
 */
export async function handleStripeWebhookEvent(
  dbClient: DbClient,
  ctx: EmitContext | null,
  event: StripeEvent
): Promise<{ status: number }> {
  const eventId = str(event.id)
  const eventType = str(event.type)
  const object = event.data?.object
  if (!eventId || !eventType || !object) {
    return { status: 400 }
  }

  try {
    return await runInTransaction<{ status: number }>(dbClient, async () => {
      const dedup = await dbClient.query(
        `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [PROVIDER, eventId, eventType]
      )
      if ((dedup.rowCount ?? 0) === 0) {
        // Replay of an already-processed event — ack without reprocessing.
        throw new Rollback({ status: 200 })
      }

      await dispatchEvent(dbClient, ctx, eventType, object)
      return { status: 200 }
    })
  } catch (error) {
    console.error(`handleStripeWebhookEvent (${eventType}):`, error)
    return { status: 500 }
  }
}

async function dispatchEvent(
  dbClient: DbClient,
  ctx: EmitContext | null,
  eventType: string,
  object: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await syncSubscription(dbClient, ctx, object, eventType)
      break
    case "customer.subscription.deleted":
      await cancelSubscription(dbClient, ctx, object)
      break
    case "invoice.finalized":
      await recordInvoice(dbClient, ctx, object, {
        event: EVENTS.BILLING_INVOICE_ISSUED,
      })
      break
    case "invoice.paid":
      await recordInvoice(dbClient, ctx, object, {
        status: "paid",
        paid: true,
        event: EVENTS.BILLING_INVOICE_PAID,
      })
      break
    case "invoice.payment_succeeded":
      await recordInvoice(dbClient, ctx, object, {
        status: "paid",
        paid: true,
        event: EVENTS.BILLING_PAYMENT_SUCCEEDED,
      })
      break
    case "invoice.payment_failed":
      await recordInvoice(dbClient, ctx, object, {
        event: EVENTS.BILLING_PAYMENT_FAILED,
      })
      break
    case "invoice.voided":
      await recordInvoice(dbClient, ctx, object, {
        status: "void",
        event: EVENTS.BILLING_INVOICE_VOIDED,
      })
      break
    default:
      // Unhandled event type: it is now recorded in billing_webhook_events
      // (so it is not reprocessed) but otherwise ignored.
      break
  }
}

async function syncSubscription(
  dbClient: DbClient,
  ctx: EmitContext | null,
  object: Record<string, unknown>,
  eventType: string
): Promise<void> {
  const meta = metadataOf(object)
  const org_uuid = str(meta.org_uuid)
  const app_uuid = str(meta.app_uuid)
  if (!org_uuid || !app_uuid) {
    console.error(
      `syncSubscription: subscription ${String(object.id)} is missing org_uuid/app_uuid metadata; skipping.`
    )
    return
  }
  const tier = meta.tier ?? ""
  const sub = mapStripeSubscription(object)

  // UPSERT by the (org, app) uniqueness. A checkout-created subscription has no
  // local row yet (insert); a later update finds it (update). An empty event
  // tier preserves the stored tier rather than blanking it.
  await dbClient.query(
    `INSERT INTO subscriptions
       (subscription_uuid, org_uuid, app_uuid, provider, provider_subscription_id,
        status, tier, current_period_start, current_period_end,
        cancel_at, canceled_at, trial_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (org_uuid, app_uuid) DO UPDATE SET
       provider = excluded.provider,
       provider_subscription_id = excluded.provider_subscription_id,
       status = excluded.status,
       tier = CASE WHEN excluded.tier = '' THEN subscriptions.tier ELSE excluded.tier END,
       current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end,
       cancel_at = excluded.cancel_at,
       canceled_at = excluded.canceled_at,
       trial_end = excluded.trial_end`,
    [
      crypto.randomUUID(),
      org_uuid,
      app_uuid,
      PROVIDER,
      sub.id,
      sub.status,
      tier,
      sub.current_period_start,
      sub.current_period_end,
      sub.cancel_at,
      sub.canceled_at,
      sub.trial_end,
    ]
  )

  let event: EventType = EVENTS.BILLING_SUBSCRIPTION_UPDATED
  if (eventType === "customer.subscription.created") {
    event = EVENTS.BILLING_SUBSCRIPTION_CREATED
  } else if (eventType === "customer.subscription.resumed") {
    event = EVENTS.BILLING_SUBSCRIPTION_RESUMED
  } else if (
    eventType === "customer.subscription.paused" ||
    sub.status === "paused"
  ) {
    event = EVENTS.BILLING_SUBSCRIPTION_PAUSED
  }

  await emit(dbClient, ctx, {
    event_type: event,
    actor_user_uuid: null,
    target_org_uuid: org_uuid,
    target_app_uuid: app_uuid,
    event_metadata: { provider_subscription_id: sub.id, status: sub.status },
  })
}

async function cancelSubscription(
  dbClient: DbClient,
  ctx: EmitContext | null,
  object: Record<string, unknown>
): Promise<void> {
  const subId = str(object.id)
  if (!subId) return
  const meta = metadataOf(object)
  const sub = mapStripeSubscription(object)

  const { rows } = await dbClient.query(
    `UPDATE subscriptions
        SET status = 'canceled', canceled_at = COALESCE($2, now())
      WHERE provider_subscription_id = $1
      RETURNING org_uuid, app_uuid`,
    [subId, sub.canceled_at]
  )
  const row = rows[0] as { org_uuid?: string; app_uuid?: string } | undefined

  await emit(dbClient, ctx, {
    event_type: EVENTS.BILLING_SUBSCRIPTION_CANCELED,
    actor_user_uuid: null,
    target_org_uuid: row?.org_uuid ?? str(meta.org_uuid),
    target_app_uuid: row?.app_uuid ?? str(meta.app_uuid),
    event_metadata: { provider_subscription_id: subId },
  })
}

async function recordInvoice(
  dbClient: DbClient,
  ctx: EmitContext | null,
  object: Record<string, unknown>,
  opts: { status?: string; paid?: boolean; event: EventType }
): Promise<void> {
  const invoiceId = str(object.id)
  const subId = str(object.subscription)
  const customerId = str(object.customer)
  if (!invoiceId) return

  // Attribute the invoice to an org. Subscription invoices map via the
  // subscription row (and carry its `subscription_uuid`); one-off invoices
  // (e.g. an operator-issued charge in the Stripe dashboard) have no
  // subscription, so fall back to the customer → billing_customers → org.
  let org_uuid: string | null = null
  let subscription_uuid: string | null = null
  if (subId) {
    const { rows } = await dbClient.query(
      `SELECT subscription_uuid, org_uuid FROM subscriptions
        WHERE provider_subscription_id = $1 LIMIT 1`,
      [subId]
    )
    const row = rows[0] as
      | { subscription_uuid?: string; org_uuid?: string }
      | undefined
    org_uuid = row?.org_uuid ?? null
    subscription_uuid = row?.subscription_uuid ?? null
  }
  if (!org_uuid && customerId) {
    const { rows } = await dbClient.query(
      `SELECT org_uuid FROM billing_customers
        WHERE provider_customer_id = $1 LIMIT 1`,
      [customerId]
    )
    org_uuid = (rows[0] as { org_uuid?: string } | undefined)?.org_uuid ?? null
  }
  if (!org_uuid) {
    console.error(
      `recordInvoice: invoice ${invoiceId} has no resolvable org (subscription ${subId ?? "none"}, customer ${customerId ?? "none"}); skipping.`
    )
    return
  }

  const status = opts.status ?? str(object.status) ?? "open"
  const amount =
    typeof object.total === "number"
      ? object.total
      : typeof object.amount_due === "number"
        ? object.amount_due
        : 0
  const currency = str(object.currency) ?? "usd"

  await dbClient.query(
    `INSERT INTO invoices
       (invoice_uuid, org_uuid, subscription_uuid, provider, provider_invoice_id,
        status, amount_cents, currency, period_start, period_end,
        due_at, paid_at, hosted_invoice_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (provider_invoice_id) DO UPDATE SET
       status = excluded.status,
       amount_cents = excluded.amount_cents,
       currency = excluded.currency,
       paid_at = COALESCE(excluded.paid_at, invoices.paid_at),
       hosted_invoice_url = COALESCE(excluded.hosted_invoice_url, invoices.hosted_invoice_url)`,
    [
      crypto.randomUUID(),
      org_uuid,
      subscription_uuid,
      PROVIDER,
      invoiceId,
      status,
      amount,
      currency,
      unixToDate(object.period_start),
      unixToDate(object.period_end),
      unixToDate(object.due_date),
      opts.paid ? new Date() : null,
      str(object.hosted_invoice_url),
    ]
  )

  await emit(dbClient, ctx, {
    event_type: opts.event,
    actor_user_uuid: null,
    target_org_uuid: org_uuid,
    event_metadata: { provider_invoice_id: invoiceId, status },
  })
}
