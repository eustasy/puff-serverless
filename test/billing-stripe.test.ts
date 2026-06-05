import { describe, it, expect, vi, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import { createStripeProvider, encodeForm, mapStripeSubscription, StripeError } from "../src/billing-stripe.js"
import { fakeEnv } from "./helpers/fake-env.js"

afterEach(() => vi.unstubAllGlobals())

interface StubResponse {
  ok?: boolean
  status?: number
  json: unknown
}

// Stubs global `fetch` for the Stripe REST adapter. Each call consumes the next
// scripted response (the last one repeats). Returns the recorded calls so a
// test can assert method/URL/body/headers.
function stubStripe(responses: StubResponse[]): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async () => r.json,
      }
    })
  )
  return calls
}

const STRIPE_ENV = fakeEnv({ STRIPE_SECRET_KEY: "sk_test_123" })

describe("encodeForm", () => {
  it("flattens nested objects and arrays into Stripe bracket notation", () => {
    const encoded = encodeForm({
      customer: "cus_1",
      items: [{ price: "price_1" }],
      metadata: { org_uuid: "org-1", app_uuid: "app-1" },
    })
    const params = new URLSearchParams(encoded)
    expect(params.get("customer")).toBe("cus_1")
    expect(params.get("items[0][price]")).toBe("price_1")
    expect(params.get("metadata[org_uuid]")).toBe("org-1")
    expect(params.get("metadata[app_uuid]")).toBe("app-1")
  })

  it("drops null and undefined values", () => {
    const encoded = encodeForm({ a: "x", b: null, c: undefined })
    const params = new URLSearchParams(encoded)
    expect(params.get("a")).toBe("x")
    expect(params.has("b")).toBe(false)
    expect(params.has("c")).toBe(false)
  })
})

describe("mapStripeSubscription", () => {
  it("maps fields and converts unix timestamps to Dates", () => {
    const sub = mapStripeSubscription({
      id: "sub_1",
      status: "active",
      current_period_start: 1_700_000_000,
      current_period_end: 1_700_600_000,
      trial_end: 1_700_100_000,
      cancel_at: null,
      canceled_at: null,
    })
    expect(sub).toMatchObject({ id: "sub_1", status: "active", cancel_at: null, canceled_at: null })
    expect(sub.current_period_start).toEqual(new Date(1_700_000_000 * 1000))
    expect(sub.current_period_end).toEqual(new Date(1_700_600_000 * 1000))
    expect(sub.trial_end).toEqual(new Date(1_700_100_000 * 1000))
  })

  it("passes through the recognised statuses", () => {
    for (const status of ["trialing", "active", "past_due", "canceled", "paused", "incomplete"]) {
      expect(mapStripeSubscription({ id: "s", status }).status).toBe(status)
    }
  })

  it("collapses unpaid to past_due and incomplete_expired to incomplete", () => {
    expect(mapStripeSubscription({ id: "s", status: "unpaid" }).status).toBe("past_due")
    expect(mapStripeSubscription({ id: "s", status: "incomplete_expired" }).status).toBe("incomplete")
  })

  it("falls back to incomplete for an unknown status and epoch for missing dates", () => {
    const sub = mapStripeSubscription({ id: "s", status: "something-new" })
    expect(sub.status).toBe("incomplete")
    expect(sub.current_period_start).toEqual(new Date(0))
    expect(sub.current_period_end).toEqual(new Date(0))
    expect(sub.trial_end).toBeNull()
  })
})

describe("createStripeProvider", () => {
  it("throws when the secret key is not configured", () => {
    expect(() => createStripeProvider(fakeEnv({}))).toThrow()
  })

  it("exposes the provider name", () => {
    const provider = createStripeProvider(fakeEnv({ STRIPE_SECRET_KEY: "sk_test" }))
    expect(provider.name).toBe("stripe")
  })
})

describe("provider REST methods (fetch)", () => {
  it("creates a customer, sending auth + idempotency headers and the form body", async () => {
    const calls = stubStripe([{ json: { id: "cus_1" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const result = await provider.createCustomer({
      email: "a@b.com",
      name: "Ada",
      locale: "en",
      metadata: { org_uuid: "org-1" },
      idempotencyKey: "customer:org-1",
    })
    expect(result).toEqual({ id: "cus_1" })
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers")
    expect(calls[0].init.method).toBe("POST")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer sk_test_123")
    expect(headers["Idempotency-Key"]).toBe("customer:org-1")
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get("email")).toBe("a@b.com")
    expect(body.get("name")).toBe("Ada")
    expect(body.get("preferred_locales[0]")).toBe("en")
    expect(body.get("metadata[org_uuid]")).toBe("org-1")
  })

  it("updates a customer at the id-scoped path", async () => {
    const calls = stubStripe([{ json: { id: "cus_1" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    await provider.updateCustomer("cus_1", { email: "new@b.com" })
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers/cus_1")
    expect(new URLSearchParams(calls[0].init.body as string).get("email")).toBe("new@b.com")
  })

  it("creates a subscription with a trial period", async () => {
    const calls = stubStripe([{ json: { id: "sub_1", status: "trialing" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const sub = await provider.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
      trialDays: 14,
      metadata: { org_uuid: "org-1", app_uuid: "app-1" },
    })
    expect(sub.status).toBe("trialing")
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get("customer")).toBe("cus_1")
    expect(body.get("items[0][price]")).toBe("price_1")
    expect(body.get("trial_period_days")).toBe("14")
  })

  it("reads the current item before swapping price on an update", async () => {
    const calls = stubStripe([{ json: { items: { data: [{ id: "si_1" }] } } }, { json: { id: "sub_1", status: "active" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const sub = await provider.updateSubscription("sub_1", { priceId: "price_2", prorationBehavior: "create_prorations" })
    expect(sub.status).toBe("active")
    expect(calls[0].init.method).toBe("GET") // read existing item id
    expect(calls[1].init.method).toBe("POST")
    const body = new URLSearchParams(calls[1].init.body as string)
    expect(body.get("items[0][id]")).toBe("si_1")
    expect(body.get("items[0][price]")).toBe("price_2")
  })

  it("updates a subscription without a price change in a single request", async () => {
    const calls = stubStripe([{ json: { id: "sub_1", status: "active" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    await provider.updateSubscription("sub_1", { prorationBehavior: "none" })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe("POST")
  })

  it("cancels immediately via DELETE", async () => {
    const calls = stubStripe([{ json: { id: "sub_1", status: "canceled" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const sub = await provider.cancelSubscription("sub_1", { immediately: true })
    expect(sub.status).toBe("canceled")
    expect(calls[0].init.method).toBe("DELETE")
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_1")
  })

  it("cancels at period end via POST", async () => {
    const calls = stubStripe([{ json: { id: "sub_1", status: "active" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    await provider.cancelSubscription("sub_1", { immediately: false })
    expect(calls[0].init.method).toBe("POST")
    expect(new URLSearchParams(calls[0].init.body as string).get("cancel_at_period_end")).toBe("true")
  })

  it("creates a checkout session and returns its id and url", async () => {
    const calls = stubStripe([{ json: { id: "cs_1", url: "https://checkout/1" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const session = await provider.createCheckoutSession({
      customerId: "cus_1",
      priceId: "price_1",
      trialDays: 7,
      successUrl: "https://ok",
      cancelUrl: "https://no",
      metadata: { org_uuid: "org-1" },
    })
    expect(session).toEqual({ id: "cs_1", url: "https://checkout/1" })
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get("mode")).toBe("subscription")
    expect(body.get("subscription_data[trial_period_days]")).toBe("7")
  })

  it("creates a billing portal session", async () => {
    const calls = stubStripe([{ json: { url: "https://portal/1" } }])
    const provider = createStripeProvider(STRIPE_ENV)
    const result = await provider.createBillingPortalSession({ customerId: "cus_1", returnUrl: "https://back" })
    expect(result).toEqual({ url: "https://portal/1" })
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions")
  })

  it("records a meter event with a timestamp and identifier", async () => {
    const calls = stubStripe([{ json: {} }])
    const provider = createStripeProvider(STRIPE_ENV)
    await provider.recordMeterEvent({
      eventName: "api_calls",
      customerId: "cus_1",
      value: 42,
      identifier: "rollup-1",
      timestamp: 1_700_000_000,
    })
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing/meter_events")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toBe("rollup-1")
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get("payload[value]")).toBe("42")
    expect(body.get("timestamp")).toBe("1700000000")
  })

  it("throws a StripeError carrying the API error message on a non-2xx response", async () => {
    stubStripe([{ ok: false, status: 402, json: { error: { message: "Card declined", type: "card_error" } } }])
    const provider = createStripeProvider(STRIPE_ENV)
    await expect(provider.createCustomer({ email: null, name: null, locale: null })).rejects.toMatchObject({
      name: "StripeError",
      status: 402,
      message: "Card declined",
      type: "card_error",
    })
  })

  it("falls back to an HTTP-status message when the error body is unparseable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json")
        },
      }))
    )
    const provider = createStripeProvider(STRIPE_ENV)
    await expect(provider.createCustomer({ email: null, name: null, locale: null })).rejects.toThrow("Stripe HTTP 500")
  })
})

describe("verifyWebhookSignature", () => {
  const signingSecret = "whsec_test"
  const provider = createStripeProvider(
    fakeEnv({
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SIGNING_SECRET: signingSecret,
    })
  )

  function sign(payload: string, t: number): string {
    const sig = createHmac("sha256", signingSecret).update(`${t}.${payload}`).digest("hex")
    return `t=${t},v1=${sig}`
  }

  it("accepts a correctly signed, fresh payload", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" })
    const header = sign(payload, Math.floor(Date.now() / 1000))
    const ok = await provider.verifyWebhookSignature({
      payload,
      signatureHeader: header,
      signingSecret: "",
    })
    expect(ok).toBe(true)
  })

  it("rejects a tampered payload", async () => {
    const payload = JSON.stringify({ id: "evt_1" })
    const header = sign(payload, Math.floor(Date.now() / 1000))
    const ok = await provider.verifyWebhookSignature({
      payload: payload + "tampered",
      signatureHeader: header,
      signingSecret: "",
    })
    expect(ok).toBe(false)
  })

  it("rejects a timestamp outside tolerance", async () => {
    const payload = JSON.stringify({ id: "evt_1" })
    const header = sign(payload, Math.floor(Date.now() / 1000) - 1000)
    const ok = await provider.verifyWebhookSignature({
      payload,
      signatureHeader: header,
      signingSecret: "",
      toleranceSeconds: 300,
    })
    expect(ok).toBe(false)
  })

  it("rejects a missing or malformed header", async () => {
    const ok = await provider.verifyWebhookSignature({
      payload: "{}",
      signatureHeader: null,
      signingSecret: "",
    })
    expect(ok).toBe(false)
  })

  it("ignores header parts without an '=' and rejects when no v1 is present", async () => {
    const ok = await provider.verifyWebhookSignature({
      payload: "{}",
      signatureHeader: "garbage,t=123",
      signingSecret: "",
    })
    expect(ok).toBe(false)
  })

  it("rejects a non-numeric timestamp", async () => {
    const payload = "{}"
    const sig = createHmac("sha256", signingSecret).update(`abc.${payload}`).digest("hex")
    const ok = await provider.verifyWebhookSignature({
      payload,
      signatureHeader: `t=abc,v1=${sig}`,
      signingSecret: "",
    })
    expect(ok).toBe(false)
  })

  it("rejects a v1 of the wrong length (constant-time length guard)", async () => {
    const t = Math.floor(Date.now() / 1000)
    const ok = await provider.verifyWebhookSignature({
      payload: "{}",
      signatureHeader: `t=${t},v1=deadbeef`,
      signingSecret: "",
    })
    expect(ok).toBe(false)
  })

  it("falls back to the env signing secret when none is passed", async () => {
    const payload = JSON.stringify({ id: "evt_2" })
    const header = sign(payload, Math.floor(Date.now() / 1000))
    // signingSecret omitted -> the provider uses STRIPE_WEBHOOK_SIGNING_SECRET.
    const ok = await provider.verifyWebhookSignature({ payload, signatureHeader: header, signingSecret: "" })
    expect(ok).toBe(true)
  })

  it("StripeError is constructed with status and optional type", () => {
    const err = new StripeError("boom", 400, "invalid_request_error")
    expect(err).toMatchObject({ name: "StripeError", status: 400, type: "invalid_request_error" })
  })
})
