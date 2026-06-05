import { describe, it, expect } from "vitest"
import { buildSessionCookie, buildClearSessionCookie, unauthorizedResponse } from "../../src/utilities/session-cookie.js"
import { fakeEnv } from "../helpers/fake-env.js"

describe("buildSessionCookie", () => {
  it("emits the session value with the secure defaults and a 30-day Max-Age", () => {
    const cookie = buildSessionCookie(fakeEnv(), "sess-abc")
    expect(cookie).toContain("session_token=sess-abc")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Max-Age=2592000")
  })

  it("honours COOKIE_SAMESITE and SESSION_MAX_AGE_SECONDS overrides", () => {
    const cookie = buildSessionCookie(fakeEnv({ COOKIE_SAMESITE: "Strict", SESSION_MAX_AGE_SECONDS: "60" }), "sess-abc")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Max-Age=60")
  })

  it("appends Secure only when SECURE_COOKIE is set", () => {
    expect(buildSessionCookie(fakeEnv({ SECURE_COOKIE: "true" }), "s")).toContain("Secure")
    expect(buildSessionCookie(fakeEnv(), "s")).not.toContain("Secure")
  })
})

describe("buildClearSessionCookie", () => {
  it("clears the cookie with a 1970 Expires and no value", () => {
    const cookie = buildClearSessionCookie(fakeEnv())
    expect(cookie).toContain("session_token=;")
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("appends Secure only when SECURE_COOKIE is set", () => {
    expect(buildClearSessionCookie(fakeEnv({ SECURE_COOKIE: "true" }))).toContain("Secure")
    expect(buildClearSessionCookie(fakeEnv())).not.toContain("Secure")
  })
})

describe("unauthorizedResponse", () => {
  it("redirects HTMX requests to /login with an empty body and clears the cookie", async () => {
    const response = unauthorizedResponse(fakeEnv(), true, "Session expired", "You were logged out.")
    expect(response.status).toBe(401)
    expect(response.headers.get("HX-Redirect")).toBe("/login")
    expect(response.headers.get("Set-Cookie")).toContain("session_token=;")
    expect(await response.text()).toBe("")
  })

  it("returns an HTML fragment with the heading and message for direct navigation", async () => {
    const response = unauthorizedResponse(fakeEnv(), false, "Session expired", "You were logged out.")
    expect(response.status).toBe(401)
    expect(response.headers.get("HX-Redirect")).toBeNull()
    expect(response.headers.get("Content-Type")).toContain("text/html")
    const body = await response.text()
    expect(body).toContain("Session expired")
    expect(body).toContain("You were logged out.")
    expect(body).toContain('href="/login"')
  })
})
