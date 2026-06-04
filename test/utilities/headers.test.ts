import { describe, it, expect } from "vitest"
import { getCookie, parseUserAgent } from "../../src/utilities/headers.js"

describe("getCookie", () => {
  it("returns null when the cookie string is null or empty", async () => {
    expect(await getCookie(null, "session_token")).toBeNull()
    expect(await getCookie("", "session_token")).toBeNull()
  })

  it("returns the value of a named cookie", async () => {
    expect(await getCookie("session_token=abc123", "session_token")).toBe("abc123")
  })

  it("finds a cookie among several, ignoring surrounding whitespace", async () => {
    const header = "theme=dark; session_token=abc123; lang=en"
    expect(await getCookie(header, "session_token")).toBe("abc123")
    expect(await getCookie(header, "lang")).toBe("en")
  })

  it("returns null when the named cookie is absent", async () => {
    expect(await getCookie("theme=dark", "session_token")).toBeNull()
  })

  it("URI-decodes the cookie value", async () => {
    expect(await getCookie("login_next=%2Faccount%2Fsettings", "login_next")).toBe("/account/settings")
  })
})

describe("parseUserAgent", () => {
  it("returns N/A when the User-Agent is null", () => {
    expect(parseUserAgent(null)).toBe("N/A")
  })

  it("identifies Chrome on Windows 10/11", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    expect(parseUserAgent(ua)).toBe("Chrome on Windows 10/11")
  })

  it("identifies Firefox on macOS", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0"
    expect(parseUserAgent(ua)).toBe("Firefox on macOS")
  })

  it("prefers the specific brand when a UA carries several browser tokens", () => {
    // A Chrome UA also contains "Safari/"; Edge contains "Chrome/" too.
    const edge = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
    expect(parseUserAgent(edge)).toBe("Edge (Chromium) on Windows 10/11")
  })

  it("returns just the browser when the OS is unknown", () => {
    expect(parseUserAgent("Firefox/121.0")).toBe("Firefox")
  })

  it("returns a short unrecognised UA verbatim", () => {
    expect(parseUserAgent("curl/8.4.0")).toBe("curl/8.4.0")
  })

  it("truncates a long unrecognised UA to 30 characters with an ellipsis", () => {
    const ua = "x".repeat(50)
    expect(parseUserAgent(ua)).toBe("x".repeat(30) + "...")
  })
})
