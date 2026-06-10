// Methods that cannot change server state — exempt from the cross-origin guard.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Same-origin write guard (internal CORS / anti-CSRF).
 *
 * `SameSite=Lax` (the default session-cookie policy) already blocks classic
 * cross-SITE CSRF. It does NOT block a request from a sibling subdomain — same
 * site, different origin — which matters for an SSO deployment under a shared
 * registrable domain. For state-changing methods this guard requires the
 * browser-set `Sec-Fetch-Site: same-origin`, falling back to an `Origin`-header
 * match where `Sec-Fetch-*` is absent. A request carrying neither header is a
 * non-browser client with no victim cookie jar, so it is not a CSRF vector and
 * is allowed through.
 *
 * Token-gated GETs (e.g. `/api/email/verify`) are exempt automatically:
 * GET is a safe method, and the URL token is the capability.
 */
export const sameOriginWriteGuard: Handler = (context) => {
  const { request } = context

  if (!SAFE_METHODS.has(request.method)) {
    const secFetchSite = request.headers.get("Sec-Fetch-Site")
    const origin = request.headers.get("Origin")

    let blocked = false
    if (secFetchSite !== null) {
      // Sent by all current browsers; cannot be set by page JavaScript.
      blocked = secFetchSite !== "same-origin"
    } else if (origin !== null) {
      // Older browser, or a client that sends Origin but not Sec-Fetch-*.
      blocked = origin !== new URL(request.url).origin
    }
    // Neither header present -> not a browser-driven request; allowed.

    if (blocked) {
      const { pathname } = new URL(request.url)
      console.warn(
        `Blocked cross-origin ${request.method} ${pathname} ` + `(Sec-Fetch-Site=${secFetchSite ?? "absent"}, Origin=${origin ?? "absent"})`
      )
      return new Response('<p class="result-negative">Request blocked: cross-origin requests are not allowed.</p>', {
        status: 403,
        headers: { "Content-Type": "text/html" },
      })
    }
  }

  return context.next()
}

/**
 * Parses the `EXTERNAL_CORS_ORIGINS` allowlist (comma-separated origins) into a
 * Set. Default-deny: an unset or empty var yields an empty Set, so no origin is
 * ever allowed unless an operator explicitly opts one in.
 */
function parseAllowedExternalOrigins(env: Env): Set<string> {
  const raw = env.EXTERNAL_CORS_ORIGINS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  )
}

/** True only when `origin` is non-null and present in the env allowlist. */
function isAllowedExternalOrigin(env: Env, origin: string | null): origin is string {
  if (!origin) return false
  return parseAllowedExternalOrigins(env).has(origin)
}

/** Builds the CORS response headers for a preflight, echoing `allowOrigin` when set. */
function corsHeaders(allowOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin
    headers["Vary"] = "Origin"
  }
  return headers
}

/**
 * External CORS guard (third-party callers).
 *
 * Third-party callers are authenticated by a Stripe signature or app token
 * *inside the handler*, never by the ambient session cookie. With no ambient
 * credential there is no CSRF vector, so this guard never blocks on origin — it
 * implements real CORS instead:
 *
 *  - `OPTIONS` preflight is answered here with a 204 and the CORS headers (route
 *    handlers export no `onRequestOptions`).
 *  - Otherwise it proceeds, and if the request's `Origin` is allowlisted, it
 *    appends `Access-Control-Allow-Origin` + `Vary: Origin` to the response.
 *
 * Server-to-server callers (e.g. Stripe webhooks) send no `Origin`, so there is
 * nothing to echo and the response passes through unchanged.
 */
export const externalCorsGuard: Handler = async (context) => {
  const { request, env } = context
  const origin = request.headers.get("Origin")
  const allowOrigin = isAllowedExternalOrigin(env, origin) ? origin : null // env allowlist

  // Preflight: route handlers export no onRequestOptions, so answer it here.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) })
  }

  // No ambient cookie ⇒ not a CSRF vector ⇒ never blocked on origin. Stripe is
  // server-to-server (no Origin, nothing to echo); browser callers get the header.
  const response = await context.next()
  if (!allowOrigin) return response
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", allowOrigin)
  headers.append("Vary", "Origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
