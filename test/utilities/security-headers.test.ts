import { describe, it, expect } from "vitest"
import { fakeContext } from "../helpers/fake-context.js"
import { securityHeadersMiddleware, withSecurityHeaders } from "../../src/utilities/security-headers.js"

const html = (headers: Record<string, string> = {}, status = 200) =>
  new Response("<p>ok</p>", { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } })

describe("withSecurityHeaders", () => {
  it("adds the full header set to an HTML response", async () => {
    const response = withSecurityHeaders(html())

    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000")
    expect(response.headers.get("Content-Security-Policy")).toContain("object-src 'none'")
    expect(response.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="/api/csp-report"')
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()")
    expect(await response.text()).toBe("<p>ok</p>")
  })

  it("keeps the status and existing headers of an HTML error response", () => {
    const response = withSecurityHeaders(html({ "HX-Retarget": "#message-area" }, 403))

    expect(response.status).toBe(403)
    expect(response.headers.get("HX-Retarget")).toBe("#message-area")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("does not override a header the response already carries", () => {
    const response = withSecurityHeaders(html({ "X-Frame-Options": "SAMEORIGIN" }))

    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN")
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000")
  })

  it("returns the same response when every header is already present", () => {
    const first = withSecurityHeaders(html())

    expect(withSecurityHeaders(first)).toBe(first)
  })

  it("leaves non-HTML responses untouched", () => {
    const json = new Response("{}", { headers: { "Content-Type": "application/json" } })
    const redirect = new Response(null, { status: 303, headers: { Location: "/account" } })

    expect(withSecurityHeaders(json)).toBe(json)
    expect(withSecurityHeaders(redirect)).toBe(redirect)
    expect(json.headers.has("X-Frame-Options")).toBe(false)
  })
})

describe("securityHeadersMiddleware", () => {
  it("applies the headers to the downstream handler's HTML", async () => {
    const context = fakeContext({ next: async () => html() })

    const response = await securityHeadersMiddleware(context)

    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })
})
