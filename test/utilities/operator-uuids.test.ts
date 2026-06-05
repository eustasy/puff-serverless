import { describe, it, expect } from "vitest"
import { parseOperatorUuids } from "../../src/utilities/operator-uuids.js"

describe("parseOperatorUuids", () => {
  it("returns an empty set for undefined or empty input", () => {
    expect(parseOperatorUuids(undefined).size).toBe(0)
    expect(parseOperatorUuids("").size).toBe(0)
    expect(parseOperatorUuids("   ").size).toBe(0)
  })

  it("splits on commas and whitespace", () => {
    expect(parseOperatorUuids("a,b c")).toEqual(new Set(["a", "b", "c"]))
    expect(parseOperatorUuids("a, b,\n c")).toEqual(new Set(["a", "b", "c"]))
  })

  it("collapses duplicates and drops empty fragments from trailing separators", () => {
    expect(parseOperatorUuids("a,a,,b,")).toEqual(new Set(["a", "b"]))
  })
})
