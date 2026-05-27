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

export function buildSessionCookie(env: Env, session_id: string): string {
  const parts = [
    `session_token=${session_id}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${env.COOKIE_SAMESITE || "Lax"}`,
    `Max-Age=${env.SESSION_MAX_AGE_SECONDS || 2592000}`,
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

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
