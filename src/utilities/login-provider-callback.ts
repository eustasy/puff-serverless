/** Full-page error response for the federated callback flow; callers must pass already-trusted strings. */
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

/** Redirects to target with one or more Set-Cookie headers appended (used to issue the session cookie on login). */
export function redirectTo(target: string, setCookies: string[]): Response {
  const headers = new Headers({
    "Location": target,
    "Cache-Control": "no-store",
  })
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie)
  }
  return new Response(null, { status: 302, headers })
}
