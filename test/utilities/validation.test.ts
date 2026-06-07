import { describe, it, expect } from "vitest"
import { validateDisplayName } from "../../src/utilities/validation.js"

describe("validateDisplayName", () => {
  it("returns null for a valid name", () => {
    expect(validateDisplayName("Acme Corp", "An organisation name is required.", 100)).toBeNull()
  })

  it("returns the required message when the name is empty", () => {
    expect(validateDisplayName("", "An organisation name is required.", 100)).toBe("An organisation name is required.")
  })

  it("returns the required message when the name is only whitespace", () => {
    expect(validateDisplayName("   ", "An organisation name is required.", 100)).toBe("An organisation name is required.")
  })

  it("returns an error when the name exceeds maxLength", () => {
    expect(validateDisplayName("x".repeat(101), "required", 100)).toBe("Names cannot be longer than 100 characters.")
  })
})
