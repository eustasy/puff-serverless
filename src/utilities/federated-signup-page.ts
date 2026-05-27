import { escapeHtml } from "./escape.js"

/** Full-page error response for the /federated-signup flow; escapes message before rendering. */
export function errorPage(message: string, status = 400): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-up</title></head>
<body><main>
<h1>Sign-up</h1>
<p class="result-negative">${escapeHtml(message)}</p>
<p><a href="/login">Back to sign-in</a></p>
</main></body></html>`
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}
