/** Full-page error response for the /login/[provider] flow; callers must pass already-trusted strings. */
export function errorPage(message: string, status = 400): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in error</title></head>
<body><main>
<h1>Sign-in error</h1>
<p class="result-negative">${message}</p>
<p><a href="/login">Back to sign-in</a></p>
</main></body></html>`
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}
