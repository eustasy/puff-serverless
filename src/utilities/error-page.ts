import { escapeHtml } from "./escape.js"

/**
 * Full-page HTML error response for top-level browser flows (sign-up,
 * federated sign-in, OAuth /authorize errors when redirect_uri isn't yet
 * trustworthy). `message` is always escapeHtml'd — there is no opt-out, so
 * callers that synthesise messages from provider-controlled strings
 * (error_description, exchange/fetch failure bodies, etc.) are safe by
 * default. `title` doubles as the visible heading.
 */
export function renderErrorPage(opts: { title: string; message: string; status?: number }): Response {
  const status = opts.status ?? 400
  const title = escapeHtml(opts.title)
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main>
<h1>${title}</h1>
<p class="result-negative">${escapeHtml(opts.message)}</p>
<p><a href="/login">Back to sign-in</a></p>
</main></body></html>`
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}
