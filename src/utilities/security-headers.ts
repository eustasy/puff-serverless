// Security headers for HTML the Worker generates itself. `public/_headers` only
// reaches static assets, so the pages rendered by `functions/` — the OAuth
// consent screen, invitations, organisation pages, error pages — get theirs
// here. Keep the values in step with `public/_headers`.

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; report-uri /api/csp-report; report-to csp-endpoint;",
  "Reporting-Endpoints": 'csp-endpoint="/api/csp-report"',
  "Permissions-Policy": "microphone=(), camera=(), geolocation=(), display-capture=(), web-share=()",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "DENY",
}

/**
 * Returns `response` with the security headers added when it is HTML. A header
 * the response already carries is left alone, so a static asset served through
 * the Worker keeps what `public/_headers` gave it. Non-HTML responses (JSON,
 * redirects with no body) are returned untouched.
 */
export function withSecurityHeaders(response: Response): Response {
  const contentType = response.headers.get("Content-Type") ?? ""
  if (!contentType.toLowerCase().startsWith("text/html")) return response

  const headers = new Headers(response.headers)
  let changed = false
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value)
      changed = true
    }
  }
  if (!changed) return response
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** Root middleware: applies {@link withSecurityHeaders} to whatever the rest of the chain returns. */
export const securityHeadersMiddleware: Handler = async (context) => withSecurityHeaders(await context.next())
