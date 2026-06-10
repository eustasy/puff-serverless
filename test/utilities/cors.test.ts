import { describe, it, expect } from "vitest"
import { fakeContext } from "../helpers/fake-context.js"
import { fakeEnv } from "../helpers/fake-env.js"
import { sameOriginWriteGuard, externalCorsGuard } from "../../src/utilities/cors.js"

const ALLOWED = "https://partner.example"
const corsEnv = () => fakeEnv({ EXTERNAL_CORS_ORIGINS: `${ALLOWED}, https://other.example` } as Partial<Env>)

describe("externalCorsGuard", () => {
  it("answers an OPTIONS preflight from an allowed origin with 204 + Access-Control-Allow-Origin", async () => {
    const context = fakeContext({
      env: corsEnv(),
      request: new Request("https://app.example/api/billing/usage", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED },
      }),
      next: async () => new Response("should-not-run", { status: 200 }),
    })

    const response = await externalCorsGuard(context)

    expect(response.status).toBe(204)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED)
    expect(response.headers.get("Vary")).toBe("Origin")
    // Preflight is answered here; the downstream handler must not run.
    expect(await response.text()).toBe("")
  })

  it("appends ACAO + Vary: Origin to a real request from an allowed origin", async () => {
    const context = fakeContext({
      env: corsEnv(),
      request: new Request("https://app.example/api/billing/usage", {
        method: "POST",
        headers: { Origin: ALLOWED },
      }),
      next: async () => new Response('<p class="result-positive">ok</p>', { status: 200, headers: { "Content-Type": "text/html" } }),
    })

    const response = await externalCorsGuard(context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<p class="result-positive">ok</p>')
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED)
    expect(response.headers.get("Vary")).toBe("Origin")
    // Downstream headers survive the rewrap.
    expect(response.headers.get("Content-Type")).toBe("text/html")
  })

  it("does not add ACAO for a disallowed origin", async () => {
    const context = fakeContext({
      env: corsEnv(),
      request: new Request("https://app.example/api/billing/usage", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      next: async () => new Response("downstream", { status: 200 }),
    })

    const response = await externalCorsGuard(context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("downstream")
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("does not add ACAO when EXTERNAL_CORS_ORIGINS is unset (default-deny)", async () => {
    const context = fakeContext({
      env: fakeEnv(),
      request: new Request("https://app.example/api/billing/usage", {
        method: "POST",
        headers: { Origin: ALLOWED },
      }),
      next: async () => new Response("downstream", { status: 200 }),
    })

    const response = await externalCorsGuard(context)

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("passes a server-to-server request (no Origin) through unchanged", async () => {
    const passthrough = new Response("webhook-ok", { status: 200 })
    const context = fakeContext({
      env: corsEnv(),
      request: new Request("https://app.example/api/billing/webhook", { method: "POST" }),
      next: async () => passthrough,
    })

    const response = await externalCorsGuard(context)

    // Returned as-is: same Response instance, no CORS headers grafted on.
    expect(response).toBe(passthrough)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(response.headers.get("Vary")).toBeNull()
    expect(await response.text()).toBe("webhook-ok")
  })
})

describe("sameOriginWriteGuard", () => {
  it("allows a safe GET regardless of origin headers", async () => {
    const context = fakeContext({
      request: new Request("https://app.example/api/db/email/list", { method: "GET" }),
      next: async () => new Response("ok", { status: 200 }),
    })

    const response = await sameOriginWriteGuard(context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  it("allows a same-origin POST (Sec-Fetch-Site: same-origin)", async () => {
    const context = fakeContext({
      request: new Request("https://app.example/api/db/auth/email/primary", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      }),
      next: async () => new Response("ok", { status: 200 }),
    })

    const response = await sameOriginWriteGuard(context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  it("blocks a cross-origin POST with 403 and never reaches the handler", async () => {
    let reached = false
    const context = fakeContext({
      request: new Request("https://app.example/api/db/auth/email/primary", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      next: async () => {
        reached = true
        return new Response("ok", { status: 200 })
      },
    })

    const response = await sameOriginWriteGuard(context)

    expect(response.status).toBe(403)
    expect(reached).toBe(false)
    expect(await response.text()).toContain("cross-origin requests are not allowed")
  })

  it("blocks a cross-origin POST identified by a mismatched Origin header", async () => {
    const context = fakeContext({
      request: new Request("https://app.example/api/db/auth/email/primary", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
      next: async () => new Response("ok", { status: 200 }),
    })

    const response = await sameOriginWriteGuard(context)

    expect(response.status).toBe(403)
  })

  it("allows a POST that carries neither Sec-Fetch-Site nor Origin (non-browser client)", async () => {
    const context = fakeContext({
      request: new Request("https://app.example/api/db/auth/email/primary", { method: "POST" }),
      next: async () => new Response("ok", { status: 200 }),
    })

    const response = await sameOriginWriteGuard(context)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })
})
