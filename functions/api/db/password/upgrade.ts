// Completes a login that was paused because the password is shorter than the
// current MIN_PASSWORD_LENGTH (see user/login.ts). The user is identified by
// the `password_upgrade_token` cookie set at password-login time; setting a
// compliant new password here consumes that token and grants the session — or
// hands off to the 2FA step when 2FA is enabled.
//
// This sits beside set.ts in the unauthenticated functions/api/db/password/
// layer on purpose: the user is mid-login and has no session yet — the token
// is the capability.

import {
  getMinPasswordLength,
  password_requirements,
  passwordReused,
  updatePassword,
} from "../../../../src/passwords.js"
import {
  consumeToken,
  createLoginToken,
  readToken,
} from "../../../../src/tokens.js"
import { has2fa } from "../../../../src/2fa.js"
import { createSession } from "../../../../src/sessions.js"
import { getCookie } from "../../../../src/utilities/headers.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  // Identify the paused login. Without the cookie there is nothing to upgrade.
  const upgradeToken = await getCookie(
    context.request.headers.get("Cookie"),
    "password_upgrade_token"
  )
  if (!upgradeToken) {
    return new Response(
      '<p class="result-negative">Your login session has expired. Please log in again.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  let new_password
  try {
    new_password = (await context.request.formData()).get("pw")
  } catch (e) {
    return new Response(
      '<p class="result-negative">Invalid request data.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      '<p class="result-negative">New password is missing or invalid.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  try {
    // Enforce the (raised) minimum — passing it is the whole point of the flow.
    if (
      !password_requirements(new_password, getMinPasswordLength(context.env))
    ) {
      return new Response(
        '<p class="result-negative">New password does not meet requirements.</p>',
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    // Validate the token WITHOUT consuming it first, so a rejected password
    // (too short, or previously used) does not burn the token and force the
    // user back to the login screen. consumeToken below is the single-use gate.
    const tokenRead = await readToken(dbClient, upgradeToken)
    const pending = tokenRead.success ? tokenRead.token : null
    if (
      !pending ||
      pending.token_type !== "password_upgrade" ||
      pending.is_used ||
      new Date(pending.expires_at) < new Date()
    ) {
      return new Response(
        '<p class="result-negative">Your login session has expired. Please log in again.</p>',
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    // The new password must differ from the current and every previous one —
    // in particular it cannot be the too-short password being replaced.
    const reuseResult = await passwordReused(
      dbClient,
      pending.user_uuid,
      new_password
    )
    if (reuseResult.error) {
      return new Response(
        '<p class="result-negative">Could not check password history. Please try again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }
    if (reuseResult.reused) {
      return new Response(
        '<p class="result-negative">You cannot reuse a previous password. Please choose a new one.</p>',
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    // Atomically consume the single-use token. Concurrent requests that both
    // passed the read-check above collapse to one winning UPDATE.
    const tokenResult = await consumeToken(
      dbClient,
      upgradeToken,
      "password_upgrade"
    )
    if (!tokenResult.success) {
      return new Response(
        '<p class="result-negative">Your login session has expired. Please log in again.</p>',
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    const user_uuid = tokenResult.token.user_uuid

    const updateResult = await updatePassword(dbClient, user_uuid, new_password)
    if (updateResult.error || !updateResult.success) {
      console.error(
        `Failed to update password during upgrade for user_uuid ${user_uuid}: ${updateResult.message}`
      )
      return new Response(
        '<p class="result-negative">Failed to update password. Please log in again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }

    // The password is now compliant. Resume the login where it would have gone
    // before the upgrade detour: the 2FA step, or a session. The spent upgrade
    // cookie is cleared on every outcome below. SameSite / Secure are
    // env-driven, never hardcoded.
    const sameSite = context.env.COOKIE_SAMESITE || "Lax"
    const secure = !!context.env.SECURE_COOKIE

    const clearUpgrade = [
      "password_upgrade_token=",
      "HttpOnly",
      "Path=/",
      `SameSite=${sameSite}`,
      "Max-Age=0",
    ]
    if (secure) clearUpgrade.push("Secure")

    const twoFactorResult = await has2fa(dbClient, user_uuid)
    if (twoFactorResult.error) {
      console.error(
        "Error checking 2FA status during password upgrade:",
        twoFactorResult.message
      )
      return new Response(
        '<p class="result-negative">Could not complete login. Please log in again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }

    const headers = new Headers()
    headers.append("Set-Cookie", clearUpgrade.join("; "))

    if (twoFactorResult.enabled) {
      // 2FA is enabled — hand off to the TOTP step with a fresh pending token,
      // exactly as a normal login would have once the password was verified.
      const loginToken = await createLoginToken(dbClient, user_uuid)
      if (loginToken.error) {
        console.error(
          "Error creating TOTP token after password upgrade:",
          loginToken.message
        )
        return new Response(
          '<p class="result-negative">Could not start 2FA. Please log in again.</p>',
          { status: 500, headers: { "Content-Type": "text/html" } }
        )
      }
      const totpCookie = [
        `totp_verification_token=${loginToken.token_value}`,
        "HttpOnly",
        "Path=/",
        `SameSite=${sameSite}`,
        // 15 minutes — must match the TTL set by createLoginToken
        "Max-Age=900",
      ]
      if (secure) totpCookie.push("Secure")
      headers.append("Set-Cookie", totpCookie.join("; "))
      headers.set("HX-Redirect", "/2fa")
      return new Response(null, { status: 303, headers })
    }

    // No 2FA — grant the session directly.
    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""
    const sessionResult = await createSession(
      dbClient,
      user_uuid,
      user_agent,
      ip_address,
      ip_country
    )
    if (!sessionResult.success) {
      console.error(
        "Error creating session after password upgrade:",
        sessionResult.error
      )
      return new Response(
        '<p class="result-negative">Could not complete login. Please log in again.</p>',
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }
    const sessionCookie = [
      `session_token=${sessionResult.session_id}`,
      "HttpOnly",
      "Path=/",
      `SameSite=${sameSite}`,
      `Max-Age=${context.env.SESSION_MAX_AGE_SECONDS || 2592000}`,
    ]
    if (secure) sessionCookie.push("Secure")
    headers.append("Set-Cookie", sessionCookie.join("; "))
    headers.set("HX-Redirect", "/account")
    return new Response(null, { status: 303, headers })
  } catch (error) {
    console.error("Error during password upgrade:", error)
    return new Response(
      '<p class="result-negative">Failed to upgrade password due to a server error.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
