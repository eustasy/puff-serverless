import { describe, it, expect, vi, beforeEach } from "vitest"
import { fakeContext } from "../helpers/fake-context.js"

// verifyTokenAndGetUser owns the session lookup and has its own coverage in
// sessions.test.ts; mock it here so the middleware's own branch logic (missing
// dbClient, no cookie, 401 vs 500, success, thrown error) can be driven directly.
// getCookie and unauthorizedResponse stay real.
const mocks = vi.hoisted(() => ({
  verifyTokenAndGetUser: vi.fn(),
}))
vi.mock("../../src/sessions.js", () => ({ verifyTokenAndGetUser: mocks.verifyTokenAndGetUser }))

import { sessionAuthMiddleware } from "../../src/utilities/session-auth.js"

const AUTHED = { Cookie: "session_token=tok-abc" }
const url = "https://app.example/api/email/list"

describe("sessionAuthMiddleware", () => {
  beforeEach(() => {
    mocks.verifyTokenAndGetUser.mockReset()
  })

  it("returns 503 when the DB tier did not run (no dbClient)", async () => {
    let nextCalled = false
    const context = fakeContext({
      data: { dbClient: undefined },
      request: new Request(url, { headers: AUTHED }),
      next: async () => {
        nextCalled = true
        return new Response(null, { status: 200 })
      },
    })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(503)
    expect(nextCalled).toBe(false)
    expect(mocks.verifyTokenAndGetUser).not.toHaveBeenCalled()
  })

  it("returns 401 when no session_token cookie is present", async () => {
    const context = fakeContext({ request: new Request(url) })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(401)
    expect(mocks.verifyTokenAndGetUser).not.toHaveBeenCalled()
  })

  it("returns 401 for an invalid/expired token and wires the cookie token through", async () => {
    mocks.verifyTokenAndGetUser.mockResolvedValue({ error: "Session token expired.", status: 401 })
    const context = fakeContext({ request: new Request(url, { headers: AUTHED }) })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(401)
    // The token extracted from the cookie reaches verifyTokenAndGetUser; absent
    // CF headers are passed as null.
    expect(mocks.verifyTokenAndGetUser).toHaveBeenCalledWith(expect.anything(), "tok-abc", null, null)
  })

  it("surfaces a >=500 verification status as a server error carrying the message", async () => {
    mocks.verifyTokenAndGetUser.mockResolvedValue({ error: "Token store unavailable.", status: 500 })
    const context = fakeContext({ request: new Request(url, { headers: AUTHED }) })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(500)
    expect(await response.text()).toContain("Token store unavailable.")
  })

  it("populates data.user_uuid and calls next() on success", async () => {
    mocks.verifyTokenAndGetUser.mockResolvedValue({ success: true, user_uuid: "user-1", status: 200 })
    let nextCalled = false
    const context = fakeContext({
      request: new Request(url, { headers: AUTHED }),
      next: async () => {
        nextCalled = true
        return new Response("downstream", { status: 200 })
      },
    })

    const response = await sessionAuthMiddleware(context)

    expect(nextCalled).toBe(true)
    expect(context.data.user_uuid).toBe("user-1")
    expect(await response.text()).toBe("downstream")
  })

  it("returns 500 when token verification throws", async () => {
    mocks.verifyTokenAndGetUser.mockRejectedValue(new Error("boom"))
    const context = fakeContext({ request: new Request(url, { headers: AUTHED }) })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(500)
  })

  it("redirects unauthenticated HTMX requests to /login via HX-Redirect", async () => {
    const context = fakeContext({ request: new Request(url, { headers: { "HX-Request": "true" } }) })

    const response = await sessionAuthMiddleware(context)

    expect(response.status).toBe(401)
    expect(response.headers.get("HX-Redirect")).toBe("/login")
  })

  it("forwards CF geo/IP headers to verification", async () => {
    mocks.verifyTokenAndGetUser.mockResolvedValue({ success: true, user_uuid: "user-1", status: 200 })
    const context = fakeContext({
      request: new Request(url, { headers: { ...AUTHED, "CF-IPCountry": "GB", "CF-Connecting-IP": "203.0.113.7" } }),
    })

    await sessionAuthMiddleware(context)

    expect(mocks.verifyTokenAndGetUser).toHaveBeenCalledWith(expect.anything(), "tok-abc", "GB", "203.0.113.7")
  })
})
