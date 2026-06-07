import { describe, it, expect } from "vitest"
import { encodeBytes, decodeBytes, encodeString, decodeString, encodeJson, decodeJson } from "../../src/utilities/base64url.js"

describe("encodeBytes / decodeBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const input = new Uint8Array([0, 1, 128, 255])
    expect(decodeBytes(encodeBytes(input))).toEqual(input)
  })

  it("produces URL-safe output with no padding characters", () => {
    const encoded = encodeBytes(new Uint8Array([0xfb, 0xff, 0x00]))
    expect(encoded).not.toContain("+")
    expect(encoded).not.toContain("/")
    expect(encoded).not.toContain("=")
  })

  it("throws on input containing illegal base64 characters", () => {
    expect(() => decodeBytes("!@#$%")).toThrow()
  })
})

describe("encodeString / decodeString", () => {
  it("round-trips a binary-safe string", () => {
    const s = "hello world / base64url test"
    expect(decodeString(encodeString(s))).toBe(s)
  })

  it("throws on malformed input", () => {
    expect(() => decodeString("!!!not base64!!!")).toThrow()
  })
})

describe("encodeJson / decodeJson", () => {
  it("round-trips a plain object", () => {
    const value = { a: 1, b: "two", c: [true, null] }
    expect(decodeJson(encodeJson(value))).toEqual(value)
  })

  it("throws when the decoded bytes are not valid JSON", () => {
    // "dGhpcyBpcyBub3QganNvbg" is base64url of the string "this is not json"
    expect(() => decodeJson("dGhpcyBpcyBub3QganNvbg")).toThrow()
  })
})
