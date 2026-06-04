// Completes a login from a 2FA-bypass email link (see bypass/request.ts).
//
// The link is opened as a direct browser navigation, so this is a GET — a
// safe method, exempt from the cross-origin write guard, and token-gated
// exactly like /api/db/email/verify. The token is the capability; consuming
// it atomically creates the session.
//
// A GET that creates a session means an email link-scanner could prefetch the
// link and burn the token before the user clicks — the user then re-requests.
// That is a UX cost, not a breach (a scanner discards the Set-Cookie), and it
// matches the existing email-verification link's behaviour.

import { consumeToken } from "../../../../../src/tokens.js"
import { createSession } from "../../../../../src/sessions.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const token = new URL(context.request.url).searchParams.get("token")

  if (!token) {
    return new Response('<p class="result-negative">Bypass token is missing.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  try {
    // Atomically consume the single-use bypass token. A missing, wrong-type,
    // expired, or already-used token all collapse into one outcome.
    const tokenResult = await consumeToken(dbClient, token, "totp_bypass")
    if (!tokenResult.success) {
      return new Response(
        '<p class="result-negative">This bypass link is invalid, expired, or has already been used. Please log in again.</p>',
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""

    const sessionResult = await createSession(dbClient, tokenResult.token.user_uuid, user_agent, ip_address, ip_country)
    if (!sessionResult.success) {
      console.error("Error creating session during 2FA bypass:", sessionResult.error)
      return new Response('<p class="result-negative">Could not complete login. Please try again.</p>', {
        status: 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Issue the session cookie and clear the now-irrelevant pending-login
    // cookie. SameSite / Secure are env-driven, never hardcoded.
    const headers = new Headers()

    const sessionCookie = [
      `session_token=${sessionResult.session_id}`,
      "HttpOnly",
      "Path=/",
      `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      `Max-Age=${context.env.SESSION_MAX_AGE_SECONDS || 2592000}`,
    ]
    if (context.env.SECURE_COOKIE) sessionCookie.push("Secure")
    headers.append("Set-Cookie", sessionCookie.join("; "))

    const clearPending = ["totp_verification_token=", "HttpOnly", "Path=/", `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`, "Max-Age=0"]
    if (context.env.SECURE_COOKIE) clearPending.push("Secure")
    headers.append("Set-Cookie", clearPending.join("; "))

    // An emailed link is always opened as a direct browser navigation, so a
    // plain Location redirect is correct — no HTMX is involved.
    headers.set("Location", "/account")
    return new Response(null, { status: 303, headers })
  } catch (error) {
    console.error("Error in 2FA bypass verify endpoint:", error)
    return new Response('<p class="result-negative">An internal server error occurred.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
