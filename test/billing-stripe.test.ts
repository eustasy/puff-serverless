import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { createStripeProvider, encodeForm } from "../src/billing-stripe.js"
import { fakeEnv } from "./helpers/fake-env.js"

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

describe("createStripeProvider", () => {
  it("throws when the secret key is not configured", () => {
    expect(() => createStripeProvider(fakeEnv({}))).toThrow()
  })

  it("exposes the provider name", () => {
    const provider = createStripeProvider(fakeEnv({ STRIPE_SECRET_KEY: "sk_test" }))
    expect(provider.name).toBe("stripe")
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
})
