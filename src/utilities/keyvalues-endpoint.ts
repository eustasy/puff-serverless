// Shared HTML fragment renderers for the KV endpoints — the list table is
// the only meaningful piece of repeated HTML across the 15 endpoints, so it
// lives here. Each endpoint handles its own form parsing because the inputs
// (subject params, role validation) differ.

import { escapeHtml } from "./escape.js"
import { htmlResponse, resultNegative } from "./responses.js"
import { MAX_KEY_LENGTH, MAX_VALUE_LENGTH } from "./keyvalues-shared.js"

export { MAX_KEY_LENGTH, MAX_VALUE_LENGTH }

interface KvPair {
  kv_key: string
  kv_value: string
}

/**
 * Renders a KV table fragment for the org-side endpoints. `removeBase` is
 * the endpoint base URL for the remove POST and `triggerName` is the
 * HX-Trigger event the page should listen for.
 */
export function renderKeyValueTable(
  pairs: KvPair[],
  options: {
    removeBase: string
    triggerName: string
    canWrite: boolean
    search?: string
  }
): Response {
  if (pairs.length === 0) {
    const message = options.search ? `No keys match "${escapeHtml(options.search)}".` : "No stored keys yet."
    return htmlResponse(`<p>${message}</p>`)
  }

  let html = "<table><thead><tr><th>Key</th><th>Value</th>" + (options.canWrite ? "<th>Actions</th>" : "") + "</tr></thead><tbody>"
  for (const pair of pairs) {
    html += `<tr>
        <td>${escapeHtml(pair.kv_key)}</td>
        <td>${escapeHtml(pair.kv_value)}</td>`
    if (options.canWrite) {
      html += `
        <td>
          <button
            class="btn-danger"
            hx-post="${options.removeBase}"
            hx-vals='${escapeHtml(JSON.stringify({ key: pair.kv_key }))}'
            hx-target="closest .result-area, body"
            hx-swap="innerHTML"
            hx-confirm="Are you sure you want to delete the key &quot;${escapeHtml(pair.kv_key)}&quot;?"
            hx-disabled-elt="this"
          >Delete</button>
        </td>`
    }
    html += `</tr>`
  }
  html += "</tbody></table>"
  return htmlResponse(html)
}

/**
 * Parses the `key` + `value` form inputs and validates length. Returns
 * either `{ key, value }` or a `Response` that the handler should return
 * unchanged. Keeps the per-endpoint set handlers small.
 */
export async function parseSetForm(request: Request): Promise<{ key: string; value: string } | Response> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  const rawKey = formData.get("key")
  const rawValue = formData.get("value")
  if (typeof rawKey !== "string" || rawKey.trim() === "") {
    return resultNegative("A key is required.", 400)
  }
  if (typeof rawValue !== "string") {
    return resultNegative("A value is required.", 400)
  }
  const key = rawKey.trim()
  if (key.length > MAX_KEY_LENGTH) {
    return resultNegative(`Keys cannot be longer than ${MAX_KEY_LENGTH} characters.`, 400)
  }
  if (rawValue.length > MAX_VALUE_LENGTH) {
    return resultNegative(`Values cannot be longer than ${MAX_VALUE_LENGTH} characters.`, 400)
  }
  return { key, value: rawValue }
}

/** Same shape as parseSetForm but for the remove handlers (key only). */
export async function parseKeyForm(request: Request): Promise<{ key: string } | Response> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  const rawKey = formData.get("key")
  if (typeof rawKey !== "string" || rawKey.trim() === "") {
    return resultNegative("A key is required.", 400)
  }
  return { key: rawKey.trim() }
}
