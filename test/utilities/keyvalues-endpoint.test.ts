import { describe, it, expect } from "vitest"
import {
  renderKeyValueTable,
  parseSetForm,
  parseKeyForm,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
} from "../../src/utilities/keyvalues-endpoint.js"

const formRequest = (fields: Record<string, string>): Request =>
  new Request("https://app.example/kv", { method: "POST", body: new URLSearchParams(fields) })

const jsonRequest = (): Request =>
  new Request("https://app.example/kv", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })

describe("renderKeyValueTable", () => {
  const opts = { removeBase: "/api/remove", triggerName: "kvChanged", canWrite: true }

  it("shows an empty-state message when there are no pairs", async () => {
    expect(await renderKeyValueTable([], opts).text()).toBe("<p>No stored keys yet.</p>")
  })

  it("shows a search-specific empty state, escaping the term", async () => {
    const body = await renderKeyValueTable([], { ...opts, search: "<x>" }).text()
    expect(body).toBe('<p>No keys match "&lt;x&gt;".</p>')
  })

  it("renders rows with a delete action when writable", async () => {
    const body = await renderKeyValueTable([{ kv_key: "k1", kv_value: "v1" }], opts).text()
    expect(body).toContain("<th>Actions</th>")
    expect(body).toContain("<td>k1</td>")
    expect(body).toContain("<td>v1</td>")
    expect(body).toContain('hx-post="/api/remove"')
    expect(body).toContain("Delete")
  })

  it("omits the actions column and buttons when not writable", async () => {
    const body = await renderKeyValueTable([{ kv_key: "k1", kv_value: "v1" }], { ...opts, canWrite: false }).text()
    expect(body).not.toContain("<th>Actions</th>")
    expect(body).not.toContain("Delete")
  })

  it("escapes key and value cells", async () => {
    const body = await renderKeyValueTable([{ kv_key: "<k>", kv_value: "<v>" }], { ...opts, canWrite: false }).text()
    expect(body).toContain("<td>&lt;k&gt;</td>")
    expect(body).toContain("<td>&lt;v&gt;</td>")
  })
})

describe("parseSetForm", () => {
  it("returns the trimmed key and raw value on success", async () => {
    expect(await parseSetForm(formRequest({ key: "  k  ", value: "v" }))).toEqual({ key: "k", value: "v" })
  })

  it("rejects a non-form body", async () => {
    const result = await parseSetForm(jsonRequest())
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(400)
  })

  it("rejects a missing/blank key and a missing value", async () => {
    expect(await parseSetForm(formRequest({ key: "  ", value: "v" }))).toBeInstanceOf(Response)
    expect(await parseSetForm(formRequest({ key: "k" }))).toBeInstanceOf(Response)
  })

  it("rejects an over-long key or value", async () => {
    expect(await parseSetForm(formRequest({ key: "x".repeat(MAX_KEY_LENGTH + 1), value: "v" }))).toBeInstanceOf(Response)
    expect(await parseSetForm(formRequest({ key: "k", value: "x".repeat(MAX_VALUE_LENGTH + 1) }))).toBeInstanceOf(Response)
  })
})

describe("parseKeyForm", () => {
  it("returns the trimmed key on success", async () => {
    expect(await parseKeyForm(formRequest({ key: "  k  " }))).toEqual({ key: "k" })
  })

  it("rejects a non-form body and a blank key", async () => {
    expect(await parseKeyForm(jsonRequest())).toBeInstanceOf(Response)
    expect(await parseKeyForm(formRequest({ key: "   " }))).toBeInstanceOf(Response)
  })
})
