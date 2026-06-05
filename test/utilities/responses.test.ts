import { describe, it, expect } from "vitest"
import { htmlResponse, resultPositive, resultNegative, methodNotAllowed } from "../../src/utilities/responses.js"

describe("htmlResponse", () => {
  it("defaults to 200 with a text/html content type", async () => {
    const response = htmlResponse("<p>hi</p>")
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/html")
    expect(await response.text()).toBe("<p>hi</p>")
  })

  it("applies a custom status and merges extra headers", () => {
    const response = htmlResponse("<p>x</p>", 201, { "HX-Trigger": "refresh" })
    expect(response.status).toBe(201)
    expect(response.headers.get("Content-Type")).toBe("text/html")
    expect(response.headers.get("HX-Trigger")).toBe("refresh")
  })
})

describe("resultPositive", () => {
  it("wraps the escaped message in a result-positive fragment", async () => {
    const response = resultPositive("Saved <b>now</b>")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<p class="result-positive">Saved &lt;b&gt;now&lt;/b&gt;</p>')
  })

  it("carries a custom status and headers", () => {
    const response = resultPositive("ok", 202, { "HX-Trigger": "done" })
    expect(response.status).toBe(202)
    expect(response.headers.get("HX-Trigger")).toBe("done")
  })
})

describe("resultNegative", () => {
  it("wraps the escaped message in a result-negative fragment with the given status", async () => {
    const response = resultNegative('Bad "input"', 400)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('<p class="result-negative">Bad &quot;input&quot;</p>')
  })
})

describe("methodNotAllowed", () => {
  it("returns 405 with the supplied Allow header", () => {
    const response = methodNotAllowed("GET, POST")
    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("GET, POST")
  })
})
