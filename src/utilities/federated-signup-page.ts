import { escapeHtml } from "./escape.js"

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

export function deriveUsername(
  display_name: string | null,
  email: string | null
): string {
  if (display_name && display_name.trim() !== "") return display_name.trim()
  if (email) {
    const local = email.split("@")[0]
    if (local && local.trim() !== "") return local.trim()
  }
  return "user"
}
