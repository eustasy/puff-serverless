import { describe, it, expect, vi, afterEach } from "vitest"
import { asString, asNumber, truncate, logViolation, type Violation } from "../../src/utilities/csp-report.js"

afterEach(() => vi.restoreAllMocks())

describe("asString", () => {
  it("passes strings through and coerces non-strings to empty", () => {
    expect(asString("x")).toBe("x")
    expect(asString(42)).toBe("")
    expect(asString(null)).toBe("")
    expect(asString(undefined)).toBe("")
  })
})

describe("asNumber", () => {
  it("passes numbers through and coerces non-numbers to undefined", () => {
    expect(asNumber(7)).toBe(7)
    expect(asNumber("7")).toBeUndefined()
    expect(asNumber(null)).toBeUndefined()
  })
})

describe("truncate", () => {
  it("leaves short strings unchanged", () => {
    expect(truncate("short")).toBe("short")
  })

  it("clips over-long strings to 200 chars plus an ellipsis", () => {
    const result = truncate("a".repeat(250))
    expect(result).toHaveLength(201)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("logViolation", () => {
  const base: Violation = {
    directive: "script-src",
    blockedURL: "https://evil.example/x.js",
    documentURL: "https://app.example/page",
    sourceFile: "https://app.example/page",
    lineNumber: 12,
    sample: "alert(1)",
  }

  it("formats a full violation with location and sample", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logViolation(base)
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain("'script-src'")
    expect(message).toContain("https://evil.example/x.js")
    expect(message).toContain("https://app.example/page")
    expect(message).toContain(":12")
    expect(message).toContain('sample="alert(1)"')
  })

  it('labels an empty blockedURL as "inline" and omits absent location/sample', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logViolation({ ...base, blockedURL: "", sourceFile: "", sample: "" })
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain("inline")
    expect(message).not.toContain(" at ")
    expect(message).not.toContain("sample=")
  })

  it("renders a sourceFile with an unknown line as :?", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logViolation({ ...base, lineNumber: undefined })
    expect(warn.mock.calls[0]![0] as string).toContain(":?")
  })
})
