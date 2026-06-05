import { describe, it, expect } from "vitest"
import { handleStripeWebhookEvent, type StripeEvent } from "../src/billing-webhook.js"
import { FakeDb } from "./helpers/fake-db.js"

const PERIOD_START = 1_746_057_600 // 2025-05-01 unix
const PERIOD_END = 1_748_736_000

function subscriptionEvent(type: string, over: Record<string, unknown> = {}): StripeEvent {
  return {
    id: "evt_1",
    type,
    data: {
      object: {
        id: "sub_ext",
        status: "active",
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
        metadata: { org_uuid: "org-1", app_uuid: "app-1", tier: "pro" },
        ...over,
      },
    },
  }
}

describe("handleStripeWebhookEvent", () => {
  it("returns 400 for a malformed event with no id/type", async () => {
    const db = new FakeDb()
    const result = await handleStripeWebhookEvent(db.client, null, {
      data: { object: {} },
    })
    expect(result).toEqual({ status: 400 })
  })

  it("acks a replayed event without dispatching", async () => {
    const db = new FakeDb()
    // Dedup insert hits the unique constraint -> rowCount 0 -> already handled.
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 0 })
    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.updated"))
    expect(result).toEqual({ status: 200 })
    // No subscription upsert should have been attempted.
    expect(db.calls.some((c) => /INSERT INTO subscriptions/.test(c.text))).toBe(false)
  })

  it("upserts a subscription and emits created on subscription.created", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO subscriptions/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO audit_events/, { rows: [], rowCount: 1 })

    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.created"))
    expect(result).toEqual({ status: 200 })

    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[1]).toBe("billing.subscription.created")
    // target_org_uuid is the 9th column.
    expect(audit?.values[8]).toBe("org-1")
  })

  it("emits resumed on customer.subscription.resumed", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO subscriptions/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO audit_events/, { rows: [], rowCount: 1 })

    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.resumed"))
    expect(result).toEqual({ status: 200 })
    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[1]).toBe("billing.subscription.resumed")
  })

  it("emits paused on customer.subscription.paused", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO subscriptions/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO audit_events/, { rows: [], rowCount: 1 })

    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.paused", { status: "paused" }))
    expect(result).toEqual({ status: 200 })
    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[1]).toBe("billing.subscription.paused")
  })

  it("skips a subscription event missing org/app metadata", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.updated", { metadata: {} }))
    expect(result).toEqual({ status: 200 })
    expect(db.calls.some((c) => /INSERT INTO subscriptions/.test(c.text))).toBe(false)
  })

  it("records a paid invoice attributed via its subscription", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/SELECT subscription_uuid, org_uuid FROM subscriptions/, {
      rows: [{ subscription_uuid: "s-1", org_uuid: "org-1" }],
    })
    db.on(/INSERT INTO invoices/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO audit_events/, { rows: [], rowCount: 1 })

    const event: StripeEvent = {
      id: "evt_2",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_ext",
          status: "paid",
          total: 1000,
          currency: "usd",
          subscription: "sub_ext",
          period_start: PERIOD_START,
          period_end: PERIOD_END,
          hosted_invoice_url: "https://invoice.example/in_ext",
        },
      },
    }
    const result = await handleStripeWebhookEvent(db.client, null, event)
    expect(result).toEqual({ status: 200 })

    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[1]).toBe("billing.invoice.paid")
  })

  it("attributes a subscription-less invoice via the customer fallback", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/SELECT org_uuid FROM billing_customers/, {
      rows: [{ org_uuid: "org-1" }],
    })
    db.on(/INSERT INTO invoices/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO audit_events/, { rows: [], rowCount: 1 })

    const event: StripeEvent = {
      id: "evt_4",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_oneoff",
          status: "paid",
          total: 5000,
          currency: "usd",
          customer: "cus_ext",
        },
      },
    }
    const result = await handleStripeWebhookEvent(db.client, null, event)
    expect(result).toEqual({ status: 200 })
    // subscription_uuid (3rd insert column) should be null for a one-off.
    const insert = db.calls.find((c) => /INSERT INTO invoices/.test(c.text))
    expect(insert?.values[2]).toBeNull()
  })

  it("skips an invoice that resolves to no local subscription or customer", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/SELECT subscription_uuid, org_uuid FROM subscriptions/, { rows: [] })
    const event: StripeEvent = {
      id: "evt_3",
      type: "invoice.paid",
      data: { object: { id: "in_orphan", subscription: "sub_unknown" } },
    }
    const result = await handleStripeWebhookEvent(db.client, null, event)
    expect(result).toEqual({ status: 200 })
    expect(db.calls.some((c) => /INSERT INTO invoices/.test(c.text))).toBe(false)
  })

  it("returns 500 when a dispatch query fails (so the provider retries)", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rows: [], rowCount: 1 })
    db.on(/INSERT INTO subscriptions/, new Error("boom"))
    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.created"))
    expect(result).toEqual({ status: 500 })
  })

  it("marks a subscription canceled on customer.subscription.deleted", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
    db.on(/UPDATE subscriptions/, { rows: [{ org_uuid: "org-1", app_uuid: "app-1" }] })
    db.on(/INSERT INTO audit_events/, { rowCount: 1 })
    const result = await handleStripeWebhookEvent(
      db.client,
      null,
      subscriptionEvent("customer.subscription.deleted", { canceled_at: PERIOD_END })
    )
    expect(result).toEqual({ status: 200 })
    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[1]).toBe("billing.subscription.canceled")
    expect(audit?.values[8]).toBe("org-1")
  })

  it("falls back to metadata for the org when the cancel UPDATE matches no row", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
    db.on(/UPDATE subscriptions/, { rows: [] }) // no local row matched
    db.on(/INSERT INTO audit_events/, { rowCount: 1 })
    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.deleted"))
    expect(result).toEqual({ status: 200 })
    const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
    expect(audit?.values[8]).toBe("org-1") // from metadata fallback
  })

  it("ignores a subscription.deleted event with no subscription id", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
    const result = await handleStripeWebhookEvent(db.client, null, subscriptionEvent("customer.subscription.deleted", { id: undefined }))
    expect(result).toEqual({ status: 200 })
    expect(db.calls.some((c) => /UPDATE subscriptions/.test(c.text))).toBe(false)
  })

  it("records the invoice and emits the matching event for each invoice type", async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["invoice.finalized", "billing.invoice.issued", {}],
      ["invoice.payment_succeeded", "billing.payment.succeeded", {}],
      ["invoice.payment_failed", "billing.payment.failed", {}],
      ["invoice.voided", "billing.invoice.voided", {}],
    ]
    for (const [type, expected, over] of cases) {
      const db = new FakeDb()
      db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
      db.on(/SELECT subscription_uuid, org_uuid FROM subscriptions/, { rows: [{ subscription_uuid: "s-1", org_uuid: "org-1" }] })
      db.on(/INSERT INTO invoices/, { rowCount: 1 })
      db.on(/INSERT INTO audit_events/, { rowCount: 1 })
      const event: StripeEvent = {
        id: `evt_${type}`,
        type,
        data: { object: { id: "in_ext", status: "open", total: 1000, currency: "usd", subscription: "sub_ext", ...over } },
      }
      const result = await handleStripeWebhookEvent(db.client, null, event)
      expect(result, type).toEqual({ status: 200 })
      const audit = db.calls.find((c) => /INSERT INTO audit_events/.test(c.text))
      expect(audit?.values[1], type).toBe(expected)
    }
  })

  it("acks but does nothing for an unhandled event type", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
    const event: StripeEvent = { id: "evt_x", type: "customer.created", data: { object: { id: "cus_1" } } }
    const result = await handleStripeWebhookEvent(db.client, null, event)
    expect(result).toEqual({ status: 200 })
    // Recorded for dedup, but no subscription/invoice writes.
    expect(db.calls.some((c) => /INSERT INTO (subscriptions|invoices)/.test(c.text))).toBe(false)
  })

  it("ignores an invoice event with no invoice id", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO billing_webhook_events/, { rowCount: 1 })
    const event: StripeEvent = { id: "evt_noid", type: "invoice.paid", data: { object: { subscription: "sub_ext" } } }
    const result = await handleStripeWebhookEvent(db.client, null, event)
    expect(result).toEqual({ status: 200 })
    expect(db.calls.some((c) => /INSERT INTO invoices/.test(c.text))).toBe(false)
  })
})
