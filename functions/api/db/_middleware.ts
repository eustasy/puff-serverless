import { Client } from "pg"

// Methods that cannot change server state — exempt from the cross-origin guard.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Cross-origin write guard.
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
 * Token-gated GETs (e.g. `/api/db/email/verify`) are exempt automatically:
 * GET is a safe method, and the URL token is the capability.
 */
const crossOriginWriteGuard: Handler = (context) => {
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
        `Blocked cross-origin ${request.method} ${pathname} ` +
          `(Sec-Fetch-Site=${secFetchSite ?? "absent"}, Origin=${origin ?? "absent"})`
      )
      return new Response(
        '<p class="result-negative">Request blocked: cross-origin requests are not allowed.</p>',
        { status: 403, headers: { "Content-Type": "text/html" } }
      )
    }
  }

  return context.next()
}

/**
 * Middleware to:
 * 1. Check for Hyperdrive configuration.
 * 2. Create a single pg.Client instance for the request.
 * 3. Attach the client to context.data.dbClient.
 * 4. Ensure the client is closed after the request is handled.
 */
const databaseConnectionMiddleware: Handler = async (context) => {
  // 1. Configuration Check
  if (
    !context ||
    !context.env ||
    !context.env.HYPERDRIVE ||
    !context.env.HYPERDRIVE.connectionString
  ) {
    console.error(
      "CRITICAL: Hyperdrive binding [HYPERDRIVE] not found in middleware. " +
        "Ensure it is configured in your wrangler.toml and Cloudflare Pages project settings."
    )
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>A configuration problem prevented us from processing your request. Please try again later.</p>',
      {
        status: 503, // Service Unavailable is more appropriate for config issues
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  // Initialize context.data if it doesn't already exist.
  if (!context.data) {
    context.data = {}
  }

  // 2. Create and connect the pg.Client
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    // 3. Attach the connected client to context.data
    context.data.dbClient = client

    // Proceed to the next function in the chain (API route handler)
    const response = await context.next()
    return response
  } catch (error) {
    console.error(
      "Middleware: Error during database client connection or downstream handler:",
      error
    )
    // If an error occurs, ensure the client is ended if it was created/connected.
    // This catch block is for errors during client.connect() or from context.next().
    // The finally block will also attempt to end the client.
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>An unexpected error occurred while processing your request. Please try again later.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  } finally {
    // 4. Ensure the client is closed after the request
    // This runs regardless of whether context.next() succeeded or threw an error,
    // as long as the client was successfully assigned to context.data.dbClient (implying connect was attempted and succeeded).
    if (context.data.dbClient) {
      try {
        await context.data.dbClient.end()
        // console.log("Middleware: Database client closed successfully.");
      } catch (endError) {
        console.error(
          "Middleware: Error while closing database client:",
          endError
        )
      }
    }
  }
}

// Applies to every request under /api/db (including /api/db/auth). The
// cross-origin guard runs first, so a blocked write never opens a DB connection.
export const onRequest = [crossOriginWriteGuard, databaseConnectionMiddleware]
