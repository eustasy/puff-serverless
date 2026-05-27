/** Builds the Set-Cookie value that issues a session_token cookie. */
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

/** Builds the Set-Cookie value that clears the session_token cookie (Max-Age=0 via Expires in the past). */
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

/**
 * Returns a 401 that always clears the session cookie. For HTMX requests it
 * sets HX-Redirect so the browser navigates to /login once, collapsing any
 * parallel in-flight requests into a single redirect rather than 10 error
 * fragments.
 */
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
