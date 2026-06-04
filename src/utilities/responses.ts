// Shared HTML-fragment response builders for API endpoints. Endpoints return
// HTML fragments (never JSON); success and failure use the `result-positive` /
// `result-negative` classes — see CLAUDE.md "Endpoint conventions".

import { escapeHtml } from "./escape.js"

const HTML_HEADERS = { "Content-Type": "text/html" }

/** A raw HTML-fragment response. `body` must already be safe HTML. */
export function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...HTML_HEADERS, ...headers },
  })
}

/**
 * A `result-positive` fragment. `message` is treated as plain text and escaped,
 * so any interpolated user input is safe.
 */
export function resultPositive(message: string, status = 200, headers: Record<string, string> = {}): Response {
  return htmlResponse(`<p class="result-positive">${escapeHtml(message)}</p>`, status, headers)
}

/** A `result-negative` fragment. `message` is escaped as plain text. */
export function resultNegative(message: string, status: number, headers: Record<string, string> = {}): Response {
  return htmlResponse(`<p class="result-negative">${escapeHtml(message)}</p>`, status, headers)
}

/** The standard 405 response with an accurate `Allow` header. */
export function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow },
  })
}
