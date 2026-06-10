// POST /api/federated-signup/confirm — consume a federated_signup_token,
// create a fresh Puff user, link the provider identity, and issue a
// session. The user lands here from /federated-signup which previewed the
// proposed account; this endpoint commits it.
//
// Email handling: if the provider gave us a verified email, we mark it
// pre-verified (no verification email is sent). If the provider gave us an
// unverified email, we create the row anyway and send a verification link
// just like normal registration. If the provider gave us no email, we
// refuse — Puff needs at least one way to reach the user.

import { consumeFederatedSignupToken } from "../../../src/federated-signup-tokens.js"
import { existsEmail, createEmail } from "../../../src/emails.js"
import { linkExternalIdentity } from "../../../src/external-identities.js"
import { createSession } from "../../../src/sessions.js"
import { sendVerificationEmail } from "../../../src/mailer.js"
import { clearNextCookie, readNext } from "../../../src/utilities/next.js"
import { resultNegative } from "../../../src/utilities/responses.js"
import { emitFromContext } from "../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../src/hooks/events.js"
import { buildSessionCookie } from "../../../src/utilities/session-cookie.js"
import { deriveUsername } from "../../../src/utilities/federated-signup.js"

export const onRequestPost: Handler = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient!

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return resultNegative("Invalid form submission.", 400)
  }
  const token = form.get("token")
  if (typeof token !== "string" || token.trim() === "") {
    return resultNegative("Missing sign-up token.", 400)
  }

  const consumed = await consumeFederatedSignupToken(dbClient, token.trim())
  if (!consumed.success) {
    return resultNegative(consumed.message, consumed.status)
  }
  const row = consumed.row

  if (!row.email) {
    return resultNegative(
      "Your provider did not share an email address. Please make your email public at your provider and try again.",
      400
    )
  }

  // Refuse if a Puff account already owns this email — we require explicit
  // linking from /account in that case (Decided 2026-05-21: no auto-link).
  const exists = await existsEmail(dbClient, row.email)
  if (exists.error) {
    return resultNegative("Server error during signup.", 500)
  }
  if (exists.exists) {
    return resultNegative("A Puff account already uses this email. Sign in first, then link this provider from your account page.", 409)
  }

  const username = deriveUsername(row.display_name, row.email)
  const user_uuid = crypto.randomUUID()
  try {
    await dbClient.query("INSERT INTO users (user_uuid, user_name) VALUES ($1, $2)", [user_uuid, username])
  } catch (error) {
    console.error("federated-signup confirm: user insert failed:", error)
    return resultNegative("Could not create your account.", 500)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ACCOUNT_REGISTERED,
    actor_user_uuid: user_uuid,
    target_user_uuid: user_uuid,
    target_label: row.email,
    event_metadata: { provider: row.provider },
  })

  // Primary email, pre-verified iff the provider confirmed it. createEmail
  // generates a verification token when `is_verified` is false; we send the
  // email so an unverified provider-supplied address still gets confirmed
  // through Puff's normal flow.
  const emailResult = await createEmail(dbClient, user_uuid, row.email, true, row.email_verified)
  if (emailResult.error) {
    console.error("federated-signup confirm: email insert failed:", emailResult.message)
    return resultNegative("Could not save your email.", 500)
  }
  if (!row.email_verified && emailResult.token_value) {
    // Fire-and-forget — the user is being redirected into their session
    // regardless of whether the verification email lands; failures are
    // already non-fatal here and surface only in logs.
    context.waitUntil(
      sendVerificationEmail(env, row.email, emailResult.token_value).then((mail) => {
        if (mail.error) {
          console.error("federated-signup confirm: verify email send failed:", mail.message)
        }
      })
    )
  }

  const link = await linkExternalIdentity(dbClient, {
    user_uuid,
    provider: row.provider,
    provider_user_id: row.provider_user_id,
    email: row.email,
    display_name: row.display_name,
  })
  if (link.error) {
    return resultNegative("Could not link the provider to your new account.", 500)
  }
  if (!link.success) {
    // Should not happen — we just created the user — but surface clearly.
    return resultNegative(link.message, link.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ACCOUNT_EXTERNAL_IDENTITY_LINKED,
    actor_user_uuid: user_uuid,
    target_user_uuid: user_uuid,
    target_label: `${row.provider}:${row.provider_user_id}`,
  })

  const sessionResult = await createSession(
    dbClient,
    user_uuid,
    request.headers.get("User-Agent") || "",
    request.headers.get("CF-Connecting-IP") || "",
    request.headers.get("CF-IPCountry") || ""
  )
  if (!sessionResult.success) {
    return resultNegative("Could not start your session.", 500)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ACCOUNT_LOGIN_SUCCESS,
    actor_user_uuid: user_uuid,
    target_user_uuid: user_uuid,
    event_metadata: { provider: row.provider },
  })

  const next = await readNext(request)
  const headers = new Headers({
    "Location": next || "/account",
    "Cache-Control": "no-store",
  })
  headers.append("Set-Cookie", buildSessionCookie(env, sessionResult.session_id))
  if (next) headers.append("Set-Cookie", clearNextCookie(env))
  return new Response(null, { status: 303, headers })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
