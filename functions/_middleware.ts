import { Client } from "pg"
import { getCookie } from "../src/utilities/headers.js"
import { verifyTokenAndGetUser } from "../src/sessions.js"

// Group A — pages that need a specific cookie to be worth serving. Missing →
// /login. Presence-only: the matching API endpoint does the real token check;
// this just avoids serving a shell guaranteed to fail.
//   /account, /logout        need a session.
//   /2fa, /password-upgrade  are mid-login flow pages reached with short-lived
//                            (15-min) flow-token cookies, not a session.
const REQUIRE_COOKIE: Record<string, string> = {
  "/account": "session_token",
  "/logout": "session_token",
  "/2fa": "totp_verification_token",
  "/password-upgrade": "password_upgrade_token",
}

// Group B — guest-only pages. A *valid* session → /account. Verified against
// the DB (not presence-only) so a stale/terminated session_token cannot trap
// the user on /login unable to sign in again.
const GUEST_ONLY = new Set(["/login", "/register"])

// IMPORTANT: every path above must also be listed in `assets.run_worker_first`
// in wrangler.jsonc, and `assets.binding` ("ASSETS") must be set. Static assets
// are served BEFORE the Worker by default — without run_worker_first this code
// never runs — and context.next() falls through to env.ASSETS.fetch() to serve
// the HTML. Keep the two path lists in sync.

// Verify a session_token against the DB. Only called when a session_token
// cookie is actually present, so logged-out visitors never open a connection.
// Fails open: a DB error serves the page rather than blocking login.
async function hasValidSession(
  env: Env,
  token: string,
  request: Request
): Promise<boolean> {
  if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return false
  const client = new Client(env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const result = await verifyTokenAndGetUser(
      client,
      token,
      request.headers.get("CF-IPCountry"),
      request.headers.get("CF-Connecting-IP")
    )
    return result.success === true
  } catch (error) {
    console.error("Root middleware session check failed:", error)
    return false
  } finally {
    try {
      await client.end()
    } catch {}
  }
}

const htmlAuthGuard: Handler = async (context) => {
  const { pathname } = new URL(context.request.url)
  const cookieHeader = context.request.headers.get("Cookie")

  const requiredCookie = REQUIRE_COOKIE[pathname]
  if (requiredCookie) {
    const cookie = await getCookie(cookieHeader, requiredCookie)
    if (!cookie) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      })
    }
    return context.next()
  }

  if (GUEST_ONLY.has(pathname)) {
    const sessionToken = await getCookie(cookieHeader, "session_token")
    if (
      sessionToken &&
      (await hasValidSession(context.env, sessionToken, context.request))
    ) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/account" },
      })
    }
    return context.next()
  }

  return context.next()
}

export const onRequest = [htmlAuthGuard]
