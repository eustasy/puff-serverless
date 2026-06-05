import { verifyTotpLogin } from "../../../../src/2fa.js"
import { createSession } from "../../../../src/sessions.js"
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"
import { getCookie } from "../../../../src/utilities/headers.js"
import { readNext, clearNextCookie } from "../../../../src/utilities/next.js"
import { buildSessionCookie } from "../../../../src/utilities/session-cookie.js"
import { resultNegative, methodNotAllowed } from "../../../../src/utilities/responses.js"

const TOTP_COOKIE = "totp_verification_token"
const HX_RETARGET = { "HX-Retarget": "#message-area" }

function buildClearTotpCookie(env: Env): string {
  const parts = [`${TOTP_COOKIE}=;`, "HttpOnly", "Path=/", "Max-Age=0", `SameSite=${env.COOKIE_SAMESITE || "Lax"}`]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

export const onRequestPost: Handler = async (context) => {
  const totpToken = await getCookie(context.request.headers.get("Cookie"), TOTP_COOKIE)
  if (!totpToken) {
    return resultNegative("Missing 2FA session. Please log in again.", 400, HX_RETARGET)
  }

  let formData: FormData
  try {
    formData = await context.request.formData()
  } catch {
    return resultNegative("Invalid request body.", 400, HX_RETARGET)
  }
  const totpCode = formData.get("otp")
  if (!totpCode || typeof totpCode !== "string") {
    return resultNegative("TOTP code is required.", 400, HX_RETARGET)
  }

  const verified = await verifyTotpLogin(context.data.dbClient!, totpToken, totpCode)
  if (!verified.success) {
    const headers: Record<string, string> = { ...HX_RETARGET }
    // Clear the pending token on all failures except wrong code (401), where
    // the token is still live and the user can retry.
    if (verified.status !== 401) headers["Set-Cookie"] = buildClearTotpCookie(context.env)
    return resultNegative(verified.message, verified.status, headers)
  }

  const { user_uuid } = verified
  const session = await createSession(
    context.data.dbClient!,
    user_uuid,
    context.request.headers.get("User-Agent") || "",
    context.request.headers.get("CF-Connecting-IP") || "",
    context.request.headers.get("CF-IPCountry") || "",
  )
  if (!session.success) {
    return resultNegative("Error creating session. Please try again.", 500, HX_RETARGET)
  }

  await emitFromContext(context, {
    event_type: EVENTS.ACCOUNT_LOGIN_SUCCESS,
    actor_user_uuid: user_uuid,
    target_user_uuid: user_uuid,
    event_metadata: { factor: "totp" },
  })

  const next = await readNext(context.request)
  const destination = next ?? "/account"
  const headers = new Headers({
    "Location": destination,
    "HX-Redirect": destination,
    "Content-Type": "text/html",
  })
  if (next) headers.append("Set-Cookie", clearNextCookie(context.env))
  headers.append("Set-Cookie", buildSessionCookie(context.env, session.session_id))
  headers.append("Set-Cookie", buildClearTotpCookie(context.env))

  return new Response('<p class="result-positive">Login successful! Redirecting...</p>', { status: 303, headers })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
