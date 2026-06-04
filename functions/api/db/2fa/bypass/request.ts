// Requests a 2FA-bypass email for a login that is stuck at the TOTP step.
//
// This replaces the old "do a password reset" fallback (which never actually
// bypassed 2FA). The user is identified by the `totp_verification_token`
// cookie set at password-login time; a one-time link is emailed to a verified
// address on the account, and opening it (see bypass/verify.ts) completes the
// login. The two factors remain: the password (already proven to reach this
// step) and control of the email inbox.

import { getCookie } from "../../../../../src/utilities/headers.js"
import { readToken, createBypassToken } from "../../../../../src/tokens.js"
import { readEmails } from "../../../../../src/emails.js"
import { sendTwoFactorBypassEmail } from "../../../../../src/mailer.js"
import { sessionExpired } from "../../../../../src/utilities/2fa-bypass-request.js"

// Generic acknowledgement — identical whether or not an email was actually
// sent, so the response never reveals account or email state.
const GENERIC_OK =
  '<p class="result-positive">If your account has a verified email address, a one-time bypass link has been sent to it.</p>'

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  // The pending-login cookie identifies who is mid-2FA. Without it there is
  // no login to bypass — send the user back to the start.
  const pendingToken = await getCookie(context.request.headers.get("Cookie"), "totp_verification_token")
  if (!pendingToken) {
    return sessionExpired()
  }

  try {
    // Validate the pending token WITHOUT consuming it — a failed send or a
    // retry must not burn the user's place in the login flow.
    const tokenResult = await readToken(dbClient, pendingToken)
    const pending = tokenResult.success ? tokenResult.token : null
    if (!pending || pending.token_type !== "totp_verification_pending" || pending.is_used || new Date(pending.expires_at) < new Date()) {
      return sessionExpired()
    }

    // Guard against the compound attack: email resets the password (factor 1)
    // then email bypasses 2FA (factor 2), leaving email as the sole factor.
    // If a password_reset token was consumed in the last 24 h for this user,
    // the inbox has already been used once — deny the bypass so email alone
    // cannot grant full access. The window matches the password_reset token
    // lifetime; tokens are retained for a month so the row will be present.
    const recentResetResult = await dbClient.query(
      "SELECT 1 FROM tokens WHERE user_uuid = $1 AND token_type = 'password_reset' AND is_used = TRUE AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1",
      [pending.user_uuid]
    )
    if ((recentResetResult.rowCount ?? 0) > 0) {
      return new Response(
        '<p class="result-negative">A password reset was recently completed on this account. For security, please log in normally using your authenticator app. If you have lost access to your authenticator, please contact support.</p>',
        { status: 403, headers: { "Content-Type": "text/html" } }
      )
    }

    // The bypass link must only ever go to an address the user has proven
    // they control. readEmails is ordered primary-first, so the first
    // verified row is the primary email when the primary is verified.
    const emails = await readEmails(dbClient, pending.user_uuid)
    const target = emails.find((email) => email.is_verified)
    if (!target) {
      // Nothing we can safely send to. Stay generic; the user simply sees no
      // email arrive. Logged for operators.
      console.warn(`2FA bypass requested for user ${pending.user_uuid} with no verified email.`)
      return new Response(GENERIC_OK, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    const bypassToken = await createBypassToken(dbClient, pending.user_uuid)
    if (bypassToken.error) {
      console.error("Failed to create 2FA bypass token:", bypassToken.message)
      return new Response(GENERIC_OK, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Delivery failures are logged but not surfaced — the response stays
    // generic so it never reveals whether an address is on file. Fire-and-
    // forget via waitUntil so the response doesn't block on Mailtrap.
    context.waitUntil(
      sendTwoFactorBypassEmail(context.env, target.email_address, bypassToken.token_value).then((mailResult) => {
        if (mailResult.error) {
          console.error("Failed to send 2FA bypass email:", mailResult.message)
        }
      })
    )

    return new Response(GENERIC_OK, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error during 2FA bypass request:", error)
    return new Response('<p class="result-negative">An unexpected error occurred. Please try again.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
