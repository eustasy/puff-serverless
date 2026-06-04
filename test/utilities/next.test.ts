import { describe, it, expect } from "vitest"
import { sanitizeNext, readNext, setNextCookie, clearNextCookie, NEXT_COOKIE } from "../../src/utilities/next.js"
import { fakeEnv } from "../helpers/fake-env.js"

describe("sanitizeNext", () => {
  it("accepts a same-origin absolute path", () => {
    expect(sanitizeNext("/account")).toBe("/account")
    expect(sanitizeNext("/account/settings?tab=2fa")).toBe("/account/settings?tab=2fa")
  })

  it("rejects empty, null and undefined input", () => {
    expect(sanitizeNext(null)).toBeNull()
    expect(sanitizeNext(undefined)).toBeNull()
    expect(sanitizeNext("")).toBeNull()
  })

  it("rejects a relative path with no leading slash", () => {
    expect(sanitizeNext("account")).toBeNull()
  })

  it("rejects an absolute URL (open-redirect attempt)", () => {
    expect(sanitizeNext("https://evil.example/")).toBeNull()
  })

  it("rejects a protocol-relative URL", () => {
    expect(sanitizeNext("//evil.example/account")).toBeNull()
  })

  it("rejects a backslash-prefixed path (browser-normalised open redirect)", () => {
    expect(sanitizeNext("/\\evil.example")).toBeNull()
  })

  it("rejects control characters and whitespace (header smuggling)", () => {
    expect(sanitizeNext("/account\nSet-Cookie: x=y")).toBeNull()
    expect(sanitizeNext("/account page")).toBeNull()
    expect(sanitizeNext("/account\t")).toBeNull()
  })
})

describe("readNext", () => {
  const requestWithCookie = (cookie: string): Request => new Request("https://app.example/", { headers: { Cookie: cookie } })

  it("returns the sanitized destination from the login_next cookie", async () => {
    const request = requestWithCookie(`${NEXT_COOKIE}=%2Faccount`)
    expect(await readNext(request)).toBe("/account")
  })

  it("returns null when the cookie is absent", async () => {
    expect(await readNext(requestWithCookie("theme=dark"))).toBeNull()
  })

  it("returns null when the stored destination is unsafe", async () => {
    const request = requestWithCookie(`${NEXT_COOKIE}=${encodeURIComponent("https://evil.example")}`)
    expect(await readNext(request)).toBeNull()
  })
})

describe("setNextCookie", () => {
  it("builds an HttpOnly, 15-minute cookie with the URI-encoded value", () => {
    const cookie = setNextCookie(fakeEnv(), "/account/settings")
    expect(cookie).toContain(`${NEXT_COOKIE}=%2Faccount%2Fsettings`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=900")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("honours COOKIE_SAMESITE and adds Secure when SECURE_COOKIE is set", () => {
    const cookie = setNextCookie(fakeEnv({ COOKIE_SAMESITE: "Strict", SECURE_COOKIE: "true" }), "/account")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Secure")
  })

  it("omits Secure when SECURE_COOKIE is unset", () => {
    expect(setNextCookie(fakeEnv(), "/account")).not.toContain("Secure")
  })
})

describe("clearNextCookie", () => {
  it("builds an expiring (Max-Age=0) cookie", () => {
    const cookie = clearNextCookie(fakeEnv())
    expect(cookie).toContain(`${NEXT_COOKIE}=`)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
  })
})
