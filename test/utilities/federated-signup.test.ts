import { describe, it, expect } from "vitest"
import { deriveUsername } from "../../src/utilities/federated-signup.js"

describe("deriveUsername", () => {
  it("prefers a trimmed display name", () => {
    expect(deriveUsername("  Ada Lovelace  ", "ada@example.com")).toBe("Ada Lovelace")
  })

  it("falls back to the email local part when the display name is blank", () => {
    expect(deriveUsername("", "ada@example.com")).toBe("ada")
    expect(deriveUsername("   ", "ada@example.com")).toBe("ada")
    expect(deriveUsername(null, "ada@example.com")).toBe("ada")
  })

  it("trims the email local part", () => {
    expect(deriveUsername(null, " ada @example.com")).toBe("ada")
  })

  it('returns "user" when neither yields anything usable', () => {
    expect(deriveUsername(null, null)).toBe("user")
    expect(deriveUsername(null, "@example.com")).toBe("user")
    expect(deriveUsername("", "")).toBe("user")
  })
})
