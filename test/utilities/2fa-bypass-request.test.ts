import { describe, it, expect } from "vitest"
import { sessionExpired } from "../../src/utilities/2fa-bypass-request.js"

describe("sessionExpired", () => {
  it("returns a 400 HTML fragment explaining the expiry", async () => {
    const response = sessionExpired()
    expect(response.status).toBe(400)
    expect(response.headers.get("Content-Type")).toBe("text/html")
    const body = await response.text()
    expect(body).toContain('class="result-negative"')
    expect(body).toContain("expired")
  })

  it("builds a fresh Response each call (no shared module-scope instance)", () => {
    expect(sessionExpired()).not.toBe(sessionExpired())
  })
})
