import { describe, it, expect } from "vitest"
import { verificationEmail, passwordResetEmail, twoFactorBypassEmail, organisationInvitationEmail } from "../src/email-templates.js"

const LINK = "https://app.example/verify?token=abc123"

describe("verificationEmail", () => {
  it("builds a verification message carrying the link", () => {
    const email = verificationEmail(LINK)
    expect(email.subject).toBe("Verify your email address")
    expect(email.text).toContain(LINK)
    expect(email.html).toContain(LINK)
    expect(email.text).toContain("24 hours")
  })

  it("wraps the HTML body in a full document", () => {
    expect(verificationEmail(LINK).html).toMatch(/^<!doctype html>/)
  })
})

describe("passwordResetEmail", () => {
  it("builds a reset message carrying the link", () => {
    const email = passwordResetEmail(LINK)
    expect(email.subject).toBe("Reset your password")
    expect(email.text).toContain(LINK)
    expect(email.html).toContain(LINK)
  })
})

describe("twoFactorBypassEmail", () => {
  it("builds a single-use bypass message that expires in 1 hour", () => {
    const email = twoFactorBypassEmail(LINK)
    expect(email.subject).toBe("Complete your login without a code")
    expect(email.text).toContain(LINK)
    expect(email.text).toContain("1 hour")
    expect(email.text).toContain("used once")
  })
})

describe("organisationInvitationEmail", () => {
  it("builds an invitation message naming the organisation", () => {
    const email = organisationInvitationEmail(LINK, "Acme")
    expect(email.subject).toContain("Acme")
    expect(email.text).toContain(LINK)
    expect(email.text).toContain("Acme")
    expect(email.text).toContain("7 days")
    expect(email.html).toContain(LINK)
  })

  it("escapes the organisation name in the HTML body", () => {
    const email = organisationInvitationEmail(LINK, "<b>Acme</b>")
    expect(email.html).toContain("&lt;b&gt;Acme&lt;/b&gt;")
    expect(email.html).not.toContain("<b>Acme</b>")
  })
})

describe("HTML escaping", () => {
  it("escapes a link with HTML-significant characters in the HTML body", () => {
    const tricky = 'https://app.example/verify?a=1&b="2"'
    const email = verificationEmail(tricky)
    // The href is escaped...
    expect(email.html).toContain("a=1&amp;b=&quot;2&quot;")
    expect(email.html).not.toContain('b="2"')
    // ...but the plain-text body keeps the raw link.
    expect(email.text).toContain(tricky)
  })
})
