import { describe, it, expect } from "vitest"
import { escapeHtml } from "../../src/utilities/escape.js"

describe("escapeHtml", () => {
  it("returns an empty string for null and undefined", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
  })

  it("leaves a string with no special characters unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world")
    expect(escapeHtml("")).toBe("")
  })

  it("escapes each of the five HTML-significant characters", () => {
    expect(escapeHtml("&")).toBe("&amp;")
    expect(escapeHtml("<")).toBe("&lt;")
    expect(escapeHtml(">")).toBe("&gt;")
    expect(escapeHtml('"')).toBe("&quot;")
    expect(escapeHtml("'")).toBe("&#39;")
  })

  it("escapes the ampersand first so escaped output is not double-escaped", () => {
    // If "<" were escaped before "&", the "&" in "&lt;" would become
    // "&amp;lt;". Escaping "&" first is what keeps this correct.
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;")
  })

  it("neutralises a script-tag injection payload", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
    )
  })

  it("escapes an attribute-breakout payload", () => {
    expect(escapeHtml('" onmouseover="evil()')).toBe(
      "&quot; onmouseover=&quot;evil()"
    )
  })

  it("coerces non-string values via String()", () => {
    expect(escapeHtml(42)).toBe("42")
    expect(escapeHtml(0)).toBe("0")
    expect(escapeHtml(false)).toBe("false")
    expect(escapeHtml(true)).toBe("true")
  })

  it("coerces and escapes a non-string value in one pass", () => {
    expect(escapeHtml(["<", "&"])).toBe("&lt;,&amp;")
  })
})
