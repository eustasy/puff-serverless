import { getCookie } from "../src/utilities/headers.js"
import { verifySessionToken } from "../src/sessions.js"

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

// Group B — guest-only pages. A *valid* session → /account. The session is
// verified against the DB (verifySessionToken, in src/sessions.ts), not just
// checked for presence, so a stale/terminated session_token cannot trap the
// user on /login unable to sign in again.
const GUEST_ONLY = new Set(["/login", "/register"])

// IMPORTANT: every path above must also be listed in `assets.run_worker_first`
// in wrangler.jsonc, and `assets.binding` ("ASSETS") must be set. Static assets
// are served BEFORE the Worker by default — without run_worker_first this code
// never runs — and context.next() falls through to env.ASSETS.fetch() to serve
// the HTML. Keep the two path lists in sync.

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

  const isGuestPage = GUEST_ONLY.has(pathname)
  if (isGuestPage) {
    const sessionToken = await getCookie(cookieHeader, "session_token")
    let sessionValid = false
    if (sessionToken) {
      sessionValid = await verifySessionToken(
        context.env,
        sessionToken,
        context.request.headers.get("CF-IPCountry"),
        context.request.headers.get("CF-Connecting-IP")
      )
    }
    if (sessionValid) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/account" },
      })
    }
  }

  return context.next()
}

export const onRequest = [htmlAuthGuard]
