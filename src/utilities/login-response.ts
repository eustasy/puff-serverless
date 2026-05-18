// Turns a successful loginUser outcome into its HTTP response: the session
// cookie, or the redirect into the 2FA / password-upgrade step. Shared by the
// login endpoint and the "re-register as an existing user" path (issue #20)
// so the two stay byte-identical.
//
// This lives in src/ rather than functions/ because every file under
// functions/ is a route — shared, non-route code cannot live there. The
// Response is always built inside the function: constructing one in the
// Workers global scope is a disallowed operation.

import type { UserLoginSuccess } from "../users.js"
import { createLoginToken, createPasswordUpgradeToken } from "../tokens.js"
import { readNext, clearNextCookie } from "./next.js"

export async function loginOutcomeResponse(
  dbClient: DbClient,
  env: Env,
  result: UserLoginSuccess,
  request: Request
): Promise<Response> {
  const sameSite = env.COOKIE_SAMESITE || "Lax"
  const secure = !!env.SECURE_COOKIE

  if (result.totp_required) {
    // 2FA is enabled — issue a short-lived pending token and send the user to
    // the TOTP step. No session yet.
    const tokenResult = await createLoginToken(dbClient, result.user_uuid)
    if (tokenResult.error) {
      console.error("Error creating TOTP token:", tokenResult.message)
      return new Response(
        '<p class="result-negative">Error initiating 2FA. Please try again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }
    const cookie = [
      `totp_verification_token=${tokenResult.token_value}`,
      "Path=/",
      "HttpOnly",
      // 15 minutes — must match the TTL set by createLoginToken
      "Max-Age=900",
      `SameSite=${sameSite}`,
    ]
    if (secure) cookie.push("Secure")
    return new Response(null, {
      status: 303,
      headers: { "Set-Cookie": cookie.join("; "), "HX-Redirect": "/2fa" },
    })
  }

  if (result.password_upgrade_required) {
    // The password is correct but shorter than the current minimum. Issue a
    // short-lived token and send the user to the forced password-change page;
    // no session is granted until they set a compliant password.
    const tokenResult = await createPasswordUpgradeToken(
      dbClient,
      result.user_uuid
    )
    if (tokenResult.error) {
      console.error(
        "Error creating password-upgrade token:",
        tokenResult.message
      )
      return new Response(
        '<p class="result-negative">Error initiating password upgrade. Please try again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }
    const cookie = [
      `password_upgrade_token=${tokenResult.token_value}`,
      "Path=/",
      "HttpOnly",
      // 15 minutes — must match the TTL set by createPasswordUpgradeToken
      "Max-Age=900",
      `SameSite=${sameSite}`,
    ]
    if (secure) cookie.push("Secure")
    return new Response(null, {
      status: 303,
      headers: {
        "Set-Cookie": cookie.join("; "),
        "HX-Redirect": "/password-upgrade",
      },
    })
  }

  // A session was created — issue the session cookie and go to the account,
  // or to the page the visitor was originally headed for (the `login_next`
  // cookie, set by the root middleware), clearing that cookie once consumed.
  const cookie = [
    `session_token=${result.session_id}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${env.SESSION_MAX_AGE_SECONDS || 2592000}`,
    `SameSite=${sameSite}`,
  ]
  if (secure) cookie.push("Secure")

  const next = await readNext(request)
  const headers = new Headers({ "HX-Redirect": next || "/account" })
  headers.append("Set-Cookie", cookie.join("; "))
  if (next) headers.append("Set-Cookie", clearNextCookie(env))

  return new Response(null, { status: 303, headers })
}
