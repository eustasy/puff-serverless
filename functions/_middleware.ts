import { getCookie } from "../src/utilities/headers.js"

// Pages that require a session cookie. This is a UX redirect only — the real
// auth gate is in functions/api/db/auth/_middleware.ts. We don't open a DB
// connection here; we just skip serving the HTML shell when there is clearly
// no session, rather than letting HTMX discover the 401s itself.
//
// /2fa and /password-upgrade are intentionally excluded: they are mid-login
// flow pages reached with totp_verification_token / password_upgrade_token
// cookies, not session_token, and protecting them here would break those flows.
//
// IMPORTANT: this middleware only runs for these paths because they are listed
// in `assets.run_worker_first` in wrangler.jsonc. Static assets are served
// BEFORE the Worker by default, so without that list a request for /account
// would be answered straight from public/account.html and this code would
// never execute. `assets.binding` ("ASSETS") must also be set — context.next()
// falls through to env.ASSETS.fetch() to serve the HTML when the cookie is
// present. Keep PROTECTED_PATHS and run_worker_first in sync.
const PROTECTED_PATHS = new Set(["/account", "/logout"])

const htmlAuthGuard: Handler = async (context) => {
  const { pathname } = new URL(context.request.url)
  if (PROTECTED_PATHS.has(pathname)) {
    const sessionToken = await getCookie(
      context.request.headers.get("Cookie"),
      "session_token"
    )
    if (!sessionToken) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      })
    }
  }
  return context.next()
}

export const onRequest = [htmlAuthGuard]
