import { describe, it, expect, vi } from "vitest"
import {
  cancelSubscription,
  createSubscription,
  ensureCustomer,
  getCustomer,
  getInvoice,
  getSubscriptionForApp,
  listAllSubscriptions,
  listInvoices,
  listPricing,
  listSubscriptions,
  openBillingPortal,
  reconcileBillingEmails,
  resolveBillingEmail,
  setBillingEmailOverride,
  startSubscriptionCheckout,
  updateSubscription,
  type BillingProvider,
  type ProviderSubscription,
} from "../src/billing.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

// A provider whose every method rejects — for the 502 adapter-error branches.
const throwing = () =>
  vi.fn(async () => {
    throw new Error("provider boom")
  })

const providerSub: ProviderSubscription = {
  id: "sub_ext",
  status: "active",
  current_period_start: new Date("2026-05-01T00:00:00Z"),
  current_period_end: new Date("2026-06-01T00:00:00Z"),
  trial_end: null,
  cancel_at: null,
  canceled_at: null,
}

const pricingRow: BillingPricingRow = {
  pricing_uuid: "pr_1",
  app_uuid: "app-1",
  tier: "pro",
  price_cents: 1000,
  currency: "usd",
  billing_interval: "month",
  provider_price_id: "price_1",
}

const subRow: SubscriptionRow = {
  subscription_uuid: "s-1",
  org_uuid: "org-1",
  app_uuid: "app-1",
  provider: "stripe",
  provider_subscription_id: "sub_ext",
  status: "active",
  tier: "pro",
  current_period_start: new Date("2026-05-01T00:00:00Z"),
  current_period_end: new Date("2026-06-01T00:00:00Z"),
  cancel_at: null,
  canceled_at: null,
  trial_end: null,
  created_at: new Date("2026-05-01T00:00:00Z"),
}

function fakeProvider(over: Partial<BillingProvider> = {}): BillingProvider {
  return {
    name: "stripe",
    createCustomer: vi.fn(async () => ({ id: "cus_ext" })),
    createSubscription: vi.fn(async () => providerSub),
    updateSubscription: vi.fn(async () => providerSub),
    cancelSubscription: vi.fn(async () => providerSub),
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_1",
      url: "https://checkout.example/cs_1",
    })),
    createBillingPortalSession: vi.fn(async () => ({
      url: "https://portal.example/p_1",
    })),
    updateCustomer: vi.fn(async () => {}),
    recordMeterEvent: vi.fn(async () => {}),
    verifyWebhookSignature: vi.fn(async () => true),
    ...over,
  }
}

describe("getCustomer", () => {
  it("returns null when the org has no billing customer", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    const result = await getCustomer(db.client, "org-1")
    expect(result).toEqual({ success: true, customer: null, status: 200 })
  })

  it("surfaces a DB error as a 500 envelope", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, pgError("XX000"))
    const result = await getCustomer(db.client, "org-1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("ensureCustomer", () => {
  it("returns the existing customer without calling the provider", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, {
      rows: [
        {
          org_uuid: "org-1",
          provider: "stripe",
          provider_customer_id: "cus_x",
        },
      ],
    })
    const provider = fakeProvider()
    const result = await ensureCustomer(db.client, provider, {
      org_uuid: "org-1",
      org_name: "Acme",
      locale: "en",
    })
    expect(result).toMatchObject({ success: true, status: 200 })
    expect(provider.createCustomer).not.toHaveBeenCalled()
  })

  it("resolves the email, creates a provider customer, and inserts the row", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    db.on(/INSERT INTO billing_customers/, {
      rows: [
        {
          org_uuid: "org-1",
          provider: "stripe",
          provider_customer_id: "cus_ext",
        },
      ],
    })
    const provider = fakeProvider()
    const result = await ensureCustomer(db.client, provider, {
      org_uuid: "org-1",
      org_name: "Acme",
      locale: "en",
    })
    expect(result).toMatchObject({ success: true, status: 201 })
    expect(provider.createCustomer).toHaveBeenCalledOnce()
    // The resolved billing-contact email is what we send to the provider.
    expect(provider.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ email: "billing@acme.test" }))
  })
})

describe("resolveBillingEmail", () => {
  it("returns the best-ranked billing contact's verified email", async () => {
    const db = new FakeDb()
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    const r = await resolveBillingEmail(db.client, "org-1")
    expect(r).toMatchObject({ success: true, email: "billing@acme.test" })
  })

  it("returns null when nobody qualifies", async () => {
    const db = new FakeDb()
    db.on(/member_roles/, { rows: [] })
    const r = await resolveBillingEmail(db.client, "org-1")
    expect(r).toMatchObject({ success: true, email: null })
  })
})

describe("setBillingEmailOverride", () => {
  it("rejects with 400 when the org has no billing customer", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    const r = await setBillingEmailOverride(db.client, fakeProvider(), {
      org_uuid: "org-1",
      email: "new@x.test",
    })
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("stores the override and patches the provider on drift", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, {
      rows: [
        {
          org_uuid: "org-1",
          provider_customer_id: "cus_1",
          billing_email: null,
          synced_email: "old@x.test",
        },
      ],
    })
    db.on(/UPDATE billing_customers SET billing_email/, { rowCount: 1 })
    db.on(/UPDATE billing_customers SET synced_email/, { rowCount: 1 })
    const provider = fakeProvider()
    const r = await setBillingEmailOverride(db.client, provider, {
      org_uuid: "org-1",
      email: "new@x.test",
    })
    expect(r).toMatchObject({ success: true, email: "new@x.test" })
    expect(provider.updateCustomer).toHaveBeenCalledWith("cus_1", {
      email: "new@x.test",
    })
  })

  it("does not patch when the override already matches synced_email", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, {
      rows: [
        {
          org_uuid: "org-1",
          provider_customer_id: "cus_1",
          billing_email: null,
          synced_email: "same@x.test",
        },
      ],
    })
    db.on(/UPDATE billing_customers SET billing_email/, { rowCount: 1 })
    const provider = fakeProvider()
    const r = await setBillingEmailOverride(db.client, provider, {
      org_uuid: "org-1",
      email: "same@x.test",
    })
    expect(r.success).toBe(true)
    expect(provider.updateCustomer).not.toHaveBeenCalled()
  })
})

describe("reconcileBillingEmails", () => {
  it("patches only the customers whose effective email drifted", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers[\s\S]*ORDER BY org_uuid/, {
      rows: [
        {
          org_uuid: "org-1",
          provider_customer_id: "cus_1",
          billing_email: "override@x.test",
          synced_email: "old@x.test",
        },
        {
          org_uuid: "org-2",
          provider_customer_id: "cus_2",
          billing_email: null,
          synced_email: "current@x.test",
        },
      ],
    })
    // org-2 has no override → resolver returns the already-synced value.
    db.on(/member_roles/, { rows: [{ email_address: "current@x.test" }] })
    db.on(/UPDATE billing_customers SET synced_email/, { rowCount: 1 })
    const provider = fakeProvider()
    const r = await reconcileBillingEmails(db.client, provider)
    expect(r).toMatchObject({ success: true, reconciled: 1 })
    expect(provider.updateCustomer).toHaveBeenCalledTimes(1)
    expect(provider.updateCustomer).toHaveBeenCalledWith("cus_1", {
      email: "override@x.test",
    })
  })
})

describe("listSubscriptions", () => {
  it("returns the rows for an org", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*ORDER BY created_at/, { rows: [subRow] })
    const result = await listSubscriptions(db.client, "org-1")
    expect(result).toEqual({
      success: true,
      subscriptions: [subRow],
      status: 200,
    })
  })
})

describe("getSubscriptionForApp", () => {
  it("returns null when no subscription exists for the app", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    const result = await getSubscriptionForApp(db.client, "org-1", "app-1")
    expect(result).toEqual({ success: true, subscription: null, status: 200 })
  })
})

describe("createSubscription", () => {
  it("rejects when the org already has a subscription for the app", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [subRow] })
    const result = await createSubscription(db.client, fakeProvider(), {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
    })
    expect(result).toMatchObject({ success: false, status: 409 })
  })

  it("rejects when the tier has no pricing", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [] })
    const result = await createSubscription(db.client, fakeProvider(), {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
    })
    expect(result).toMatchObject({ success: false, status: 400 })
  })

  it("creates at the provider and inserts the row", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    db.on(/INSERT INTO subscriptions/, { rows: [subRow] })
    const provider = fakeProvider()
    const result = await createSubscription(db.client, provider, {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
      trialDays: 14,
    })
    expect(result).toEqual({ success: true, subscription: subRow, status: 201 })
    expect(provider.createSubscription).toHaveBeenCalledOnce()
  })

  it("maps a provider failure to a 502 envelope", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    const provider = fakeProvider({
      createSubscription: vi.fn(async () => {
        throw new Error("card_declined")
      }),
    })
    const result = await createSubscription(db.client, provider, {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
    })
    expect(result).toMatchObject({ error: true, status: 502 })
  })
})

describe("updateSubscription", () => {
  it("returns 404 when the subscription is missing", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, {
      rows: [],
    })
    const result = await updateSubscription(db.client, fakeProvider(), {
      subscription_uuid: "s-x",
      newTier: "pro",
    })
    expect(result).toMatchObject({ success: false, status: 404 })
  })

  it("updates the provider and the row", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, {
      rows: [subRow],
    })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    db.on(/UPDATE subscriptions/, { rows: [{ ...subRow, tier: "pro" }] })
    const provider = fakeProvider()
    const result = await updateSubscription(db.client, provider, {
      subscription_uuid: "s-1",
      newTier: "pro",
      prorationBehavior: "always_invoice",
    })
    expect(result).toMatchObject({ success: true, status: 200 })
    expect(provider.updateSubscription).toHaveBeenCalledOnce()
  })
})

describe("cancelSubscription", () => {
  it("cancels via the provider and writes the new state", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, {
      rows: [subRow],
    })
    db.on(/UPDATE subscriptions/, {
      rows: [{ ...subRow, status: "canceled", canceled_at: new Date() }],
    })
    const canceledSub: ProviderSubscription = {
      ...providerSub,
      status: "canceled",
      canceled_at: new Date(),
    }
    const provider = fakeProvider({
      cancelSubscription: vi.fn(async () => canceledSub),
    })
    const result = await cancelSubscription(db.client, provider, {
      subscription_uuid: "s-1",
      immediately: true,
    })
    expect(result).toMatchObject({ success: true, status: 200 })
    expect(provider.cancelSubscription).toHaveBeenCalledWith("sub_ext", {
      immediately: true,
    })
  })
})

describe("startSubscriptionCheckout", () => {
  it("returns a checkout URL on the happy path", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    const result = await startSubscriptionCheckout(db.client, fakeProvider(), {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    })
    expect(result).toMatchObject({
      success: true,
      checkoutUrl: "https://checkout.example/cs_1",
      sessionId: "cs_1",
      status: 200,
    })
  })

  it("rejects when a subscription already exists", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [subRow] })
    const result = await startSubscriptionCheckout(db.client, fakeProvider(), {
      org_uuid: "org-1",
      app_uuid: "app-1",
      tier: "pro",
      customerId: "cus_ext",
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    })
    expect(result).toMatchObject({ success: false, status: 409 })
  })
})

describe("listAllSubscriptions", () => {
  it("returns subscriptions joined with org and app names", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions s\s+JOIN organisations/, {
      rows: [{ ...subRow, org_name: "Acme", app_name: "Widget" }],
    })
    const result = await listAllSubscriptions(db.client, { limit: 50 })
    expect(result).toMatchObject({ success: true, status: 200 })
    if (result.success) {
      expect(result.subscriptions[0]?.org_name).toBe("Acme")
      expect(db.calls[0]?.values).toEqual([50, 0])
    }
  })
})

describe("openBillingPortal", () => {
  it("returns a portal URL when a customer exists", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, {
      rows: [{ org_uuid: "org-1", provider_customer_id: "cus_x" }],
    })
    const result = await openBillingPortal(db.client, fakeProvider(), {
      org_uuid: "org-1",
      returnUrl: "https://app/billing",
    })
    expect(result).toMatchObject({
      success: true,
      portalUrl: "https://portal.example/p_1",
      status: 200,
    })
  })

  it("rejects when the org has no billing customer", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    const result = await openBillingPortal(db.client, fakeProvider(), {
      org_uuid: "org-1",
      returnUrl: "https://app/billing",
    })
    expect(result).toMatchObject({ success: false, status: 400 })
  })
})

describe("listInvoices", () => {
  it("returns invoice rows newest first", async () => {
    const db = new FakeDb()
    const invoice: InvoiceRow = {
      invoice_uuid: "inv-1",
      org_uuid: "org-1",
      subscription_uuid: "s-1",
      provider: "stripe",
      provider_invoice_id: "in_ext",
      status: "paid",
      amount_cents: 1000,
      currency: "usd",
      period_start: new Date("2026-05-01T00:00:00Z"),
      period_end: new Date("2026-06-01T00:00:00Z"),
      due_at: null,
      paid_at: new Date("2026-05-02T00:00:00Z"),
      hosted_invoice_url: "https://invoice.example/in_ext",
      created_at: new Date("2026-05-01T00:00:00Z"),
    }
    db.on(/FROM invoices/, { rows: [invoice] })
    const result = await listInvoices(db.client, "org-1")
    expect(result).toEqual({ success: true, invoices: [invoice], status: 200 })
  })

  it("surfaces a DB error as a 500 envelope (readList catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices/, pgError("XX000"))
    expect((await listInvoices(db.client, "org-1")).status).toBe(500)
  })
})

describe("listPricing", () => {
  it("returns the pricing rows for an app", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_pricing[\s\S]*ORDER BY tier/, { rows: [pricingRow] })
    expect(await listPricing(db.client, "app-1")).toEqual({ success: true, pricing: [pricingRow], status: 200 })
  })

  it("surfaces a DB error as a 500 envelope", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_pricing/, pgError("XX000"))
    expect((await listPricing(db.client, "app-1")).status).toBe(500)
  })
})

describe("getInvoice", () => {
  it("returns the invoice row scoped to the org", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices[\s\S]*invoice_uuid = \$2/, { rows: [{ invoice_uuid: "inv-1" }] })
    expect(await getInvoice(db.client, "org-1", "inv-1")).toMatchObject({
      success: true,
      invoice: { invoice_uuid: "inv-1" },
      status: 200,
    })
  })

  it("returns null when the invoice is absent", async () => {
    const db = new FakeDb()
    db.on(/FROM invoices[\s\S]*invoice_uuid = \$2/, { rows: [] })
    expect(await getInvoice(db.client, "org-1", "inv-x")).toMatchObject({ success: true, invoice: null })
  })
})

describe("resolveBillingEmail (error)", () => {
  it("surfaces a DB error as a 500 envelope", async () => {
    const db = new FakeDb()
    db.on(/member_roles/, pgError("XX000"))
    expect((await resolveBillingEmail(db.client, "org-1")).status).toBe(500)
  })
})

describe("listSubscriptions / listAllSubscriptions (errors)", () => {
  it("listSubscriptions surfaces a DB error as 500", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*ORDER BY created_at/, pgError("XX000"))
    expect((await listSubscriptions(db.client, "org-1")).status).toBe(500)
  })

  it("listAllSubscriptions surfaces a DB error as 500", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions s/, pgError("XX000"))
    expect((await listAllSubscriptions(db.client, {})).status).toBe(500)
  })
})

describe("ensureCustomer (error & race paths)", () => {
  it("propagates a getCustomer DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, pgError("XX000"))
    const r = await ensureCustomer(db.client, fakeProvider(), { org_uuid: "org-1", org_name: "Acme", locale: "en" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("propagates a resolveBillingEmail DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    db.on(/member_roles/, pgError("XX000"))
    const r = await ensureCustomer(db.client, fakeProvider(), { org_uuid: "org-1", org_name: "Acme", locale: "en" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("maps a provider createCustomer failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    const r = await ensureCustomer(db.client, fakeProvider({ createCustomer: throwing() }), {
      org_uuid: "org-1",
      org_name: "Acme",
      locale: "en",
    })
    expect(r).toMatchObject({ error: true, status: 502 })
  })

  it("resolves the race winner when the insert is a no-op", async () => {
    const db = new FakeDb()
    // First read → no row; the post-insert re-read → the winning row.
    db.once(/FROM billing_customers/, { rows: [] })
    db.on(/FROM billing_customers/, { rows: [{ org_uuid: "org-1", provider: "stripe", provider_customer_id: "cus_winner" }] })
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    db.on(/INSERT INTO billing_customers/, { rows: [] }) // lost the race
    const r = await ensureCustomer(db.client, fakeProvider(), { org_uuid: "org-1", org_name: "Acme", locale: "en" })
    expect(r).toMatchObject({ success: true, status: 200, customer: { provider_customer_id: "cus_winner" } })
  })

  it("returns 500 when the row cannot be reloaded after a lost race", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] }) // both reads miss
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    db.on(/INSERT INTO billing_customers/, { rows: [] })
    const r = await ensureCustomer(db.client, fakeProvider(), { org_uuid: "org-1", org_name: "Acme", locale: "en" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("surfaces an insert failure as a 500 (catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [] })
    db.on(/member_roles/, { rows: [{ email_address: "billing@acme.test" }] })
    db.on(/INSERT INTO billing_customers/, pgError("XX000"))
    const r = await ensureCustomer(db.client, fakeProvider(), { org_uuid: "org-1", org_name: "Acme", locale: "en" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("setBillingEmailOverride (error & clear paths)", () => {
  const customerRow = { org_uuid: "org-1", provider_customer_id: "cus_1", billing_email: "override@x.test", synced_email: "old@x.test" }

  it("propagates a getCustomer DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, pgError("XX000"))
    const r = await setBillingEmailOverride(db.client, fakeProvider(), { org_uuid: "org-1", email: "new@x.test" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("falls back to the resolved email when the override is cleared", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [customerRow] })
    db.on(/member_roles/, { rows: [{ email_address: "resolved@x.test" }] })
    db.on(/UPDATE billing_customers SET billing_email/, { rowCount: 1 })
    db.on(/UPDATE billing_customers SET synced_email/, { rowCount: 1 })
    const provider = fakeProvider()
    const r = await setBillingEmailOverride(db.client, provider, { org_uuid: "org-1", email: null })
    expect(r).toMatchObject({ success: true, email: "resolved@x.test" })
    expect(provider.updateCustomer).toHaveBeenCalledWith("cus_1", { email: "resolved@x.test" })
  })

  it("propagates a resolve error when clearing the override", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [customerRow] })
    db.on(/member_roles/, pgError("XX000"))
    const r = await setBillingEmailOverride(db.client, fakeProvider(), { org_uuid: "org-1", email: "  " })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("maps a provider updateCustomer failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [customerRow] })
    db.on(/UPDATE billing_customers SET billing_email/, { rowCount: 1 })
    const r = await setBillingEmailOverride(db.client, fakeProvider({ updateCustomer: throwing() }), {
      org_uuid: "org-1",
      email: "new@x.test",
    })
    expect(r).toMatchObject({ error: true, status: 502 })
  })

  it("surfaces a DB write failure as a 500 (catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [customerRow] })
    db.on(/UPDATE billing_customers SET billing_email/, pgError("XX000"))
    const r = await setBillingEmailOverride(db.client, fakeProvider(), { org_uuid: "org-1", email: "new@x.test" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("reconcileBillingEmails (skip & error paths)", () => {
  it("skips a customer whose email cannot be resolved", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers[\s\S]*ORDER BY org_uuid/, {
      rows: [{ org_uuid: "org-1", provider_customer_id: "cus_1", billing_email: null, synced_email: "x@x.test" }],
    })
    db.on(/member_roles/, pgError("XX000"))
    const provider = fakeProvider()
    const r = await reconcileBillingEmails(db.client, provider)
    expect(r).toMatchObject({ success: true, reconciled: 0 })
    expect(provider.updateCustomer).not.toHaveBeenCalled()
  })

  it("logs and skips a customer whose provider update throws", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers[\s\S]*ORDER BY org_uuid/, {
      rows: [{ org_uuid: "org-1", provider_customer_id: "cus_1", billing_email: "override@x.test", synced_email: "old@x.test" }],
    })
    const r = await reconcileBillingEmails(db.client, fakeProvider({ updateCustomer: throwing() }))
    expect(r).toMatchObject({ success: true, reconciled: 0 })
  })

  it("surfaces the listing DB error as a 500 envelope", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers[\s\S]*ORDER BY org_uuid/, pgError("XX000"))
    expect((await reconcileBillingEmails(db.client, fakeProvider())).status).toBe(500)
  })
})

describe("createSubscription (error paths)", () => {
  it("propagates the existing-subscription lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, pgError("XX000"))
    const r = await createSubscription(db.client, fakeProvider(), { org_uuid: "org-1", app_uuid: "app-1", tier: "pro", customerId: "cus" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("propagates the pricing lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, pgError("XX000"))
    const r = await createSubscription(db.client, fakeProvider(), { org_uuid: "org-1", app_uuid: "app-1", tier: "pro", customerId: "cus" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("surfaces an insert failure as a 500 (catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    db.on(/INSERT INTO subscriptions/, pgError("XX000"))
    const r = await createSubscription(db.client, fakeProvider(), { org_uuid: "org-1", app_uuid: "app-1", tier: "pro", customerId: "cus" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("updateSubscription (error paths)", () => {
  it("propagates the subscription lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, pgError("XX000"))
    const r = await updateSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", newTier: "pro" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("propagates the pricing lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    db.on(/FROM billing_pricing/, pgError("XX000"))
    const r = await updateSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", newTier: "pro" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("rejects with 400 when the new tier has no pricing", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    db.on(/FROM billing_pricing/, { rows: [] })
    const r = await updateSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", newTier: "enterprise" })
    expect(r).toMatchObject({ success: false, status: 400 })
  })

  it("maps a provider failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    const r = await updateSubscription(db.client, fakeProvider({ updateSubscription: throwing() }), {
      subscription_uuid: "s-1",
      newTier: "pro",
    })
    expect(r).toMatchObject({ error: true, status: 502 })
  })

  it("surfaces the UPDATE failure as a 500 (catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    db.on(/UPDATE subscriptions/, pgError("XX000"))
    const r = await updateSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", newTier: "pro" })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("cancelSubscription (error paths)", () => {
  it("propagates the subscription lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, pgError("XX000"))
    const r = await cancelSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", immediately: true })
    expect(r).toMatchObject({ error: true, status: 500 })
  })

  it("returns 404 when the subscription is missing", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [] })
    const r = await cancelSubscription(db.client, fakeProvider(), { subscription_uuid: "s-x", immediately: true })
    expect(r).toMatchObject({ success: false, status: 404 })
  })

  it("maps a provider failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    const r = await cancelSubscription(db.client, fakeProvider({ cancelSubscription: throwing() }), {
      subscription_uuid: "s-1",
      immediately: false,
    })
    expect(r).toMatchObject({ error: true, status: 502 })
  })

  it("surfaces the UPDATE failure as a 500 (catch)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*WHERE subscription_uuid = \$1/, { rows: [subRow] })
    db.on(/UPDATE subscriptions/, pgError("XX000"))
    const r = await cancelSubscription(db.client, fakeProvider(), { subscription_uuid: "s-1", immediately: true })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("startSubscriptionCheckout (error paths)", () => {
  const ok = { org_uuid: "org-1", app_uuid: "app-1", tier: "pro", customerId: "cus", successUrl: "https://ok", cancelUrl: "https://no" }

  it("propagates the existing-subscription lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, pgError("XX000"))
    expect((await startSubscriptionCheckout(db.client, fakeProvider(), ok)).status).toBe(500)
  })

  it("propagates the pricing lookup error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, pgError("XX000"))
    expect((await startSubscriptionCheckout(db.client, fakeProvider(), ok)).status).toBe(500)
  })

  it("rejects with 400 when the tier has no pricing", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [] })
    expect((await startSubscriptionCheckout(db.client, fakeProvider(), ok)).status).toBe(400)
  })

  it("maps a provider failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions[\s\S]*app_uuid = \$2/, { rows: [] })
    db.on(/FROM billing_pricing/, { rows: [pricingRow] })
    const r = await startSubscriptionCheckout(db.client, fakeProvider({ createCheckoutSession: throwing() }), ok)
    expect(r).toMatchObject({ error: true, status: 502 })
  })
})

describe("openBillingPortal (error paths)", () => {
  it("propagates the getCustomer DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, pgError("XX000"))
    expect((await openBillingPortal(db.client, fakeProvider(), { org_uuid: "org-1", returnUrl: "https://b" })).status).toBe(500)
  })

  it("maps a provider failure to a 502", async () => {
    const db = new FakeDb()
    db.on(/FROM billing_customers/, { rows: [{ org_uuid: "org-1", provider_customer_id: "cus_x" }] })
    const r = await openBillingPortal(db.client, fakeProvider({ createBillingPortalSession: throwing() }), {
      org_uuid: "org-1",
      returnUrl: "https://b",
    })
    expect(r).toMatchObject({ error: true, status: 502 })
  })
})
