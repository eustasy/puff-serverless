import { describe, it, expect } from "vitest"
import { renderErrorPage } from "../../src/utilities/error-page.js"

describe("renderErrorPage", () => {
  it("defaults to a 400 full HTML page with the title as heading", async () => {
    const response = renderErrorPage({ title: "Sign-in failed", message: "Try again." })
    expect(response.status).toBe(400)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    const body = await response.text()
    expect(body).toContain("<!doctype html>")
    expect(body).toContain("<title>Sign-in failed</title>")
    expect(body).toContain("<h1>Sign-in failed</h1>")
    expect(body).toContain('<p class="result-negative">Try again.</p>')
    expect(body).toContain('<a href="/login">Back to sign-in</a>')
  })

  it("honours a custom status", () => {
    expect(renderErrorPage({ title: "Nope", message: "x", status: 403 }).status).toBe(403)
  })

  it("escapes both the title and a provider-controlled message", async () => {
    const body = await renderErrorPage({ title: "<x>", message: "<script>alert(1)</script>" }).text()
    expect(body).toContain("<title>&lt;x&gt;</title>")
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(body).not.toContain("<script>alert(1)</script>")
  })
})
