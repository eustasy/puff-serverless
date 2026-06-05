import { describe, it, expect } from "vitest"
import { redirectWithCookies } from "../../src/utilities/login-provider-callback.js"

describe("redirectWithCookies", () => {
  it("issues a 302 to the target with no-store caching", () => {
    const response = redirectWithCookies("/account", [])
    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/account")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("appends every cookie as its own Set-Cookie header", () => {
    const response = redirectWithCookies("/account", ["session_token=abc; HttpOnly", "login_next=; Max-Age=0"])
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies.some((c) => c.startsWith("session_token=abc"))).toBe(true)
    expect(cookies.some((c) => c.startsWith("login_next="))).toBe(true)
  })
})
