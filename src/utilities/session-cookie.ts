export function buildClearSessionCookie(env: Env): string {
  const parts = [
    "session_token=;",
    "Path=/",
    "HttpOnly",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    `SameSite=${env.COOKIE_SAMESITE || "Lax"}`,
  ]
  if (env.SECURE_COOKIE) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

export function unauthorizedResponse(
  env: Env,
  isHtmx: boolean,
  heading: string,
  message: string
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html",
    "Set-Cookie": buildClearSessionCookie(env),
  }
  // HTMX honors HX-Redirect from any status code and navigates the whole
  // browser to /login, so a stale /account that fans out 10 parallel API
  // calls all redirects once rather than swapping 10 error fragments.
  if (isHtmx) {
    headers["HX-Redirect"] = "/login"
    return new Response("", { status: 401, headers })
  }
  return new Response(
    `<h1 class="result-negative">${heading}</h1>
      <p>${message}</p>
      <p>Please <a href="/login">log in</a> again.</p>`,
    { status: 401, headers }
  )
}
