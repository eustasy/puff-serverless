import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server"
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server"
import { isoBase64URL } from "@simplewebauthn/server/helpers"
import { getPasskeyByCredentialId, updatePasskeyCounter, getRpConfig } from "../../../../src/passkeys.js"
import { consumeToken } from "../../../../src/tokens.js"
import { createSession } from "../../../../src/sessions.js"
import { getCookie } from "../../../../src/utilities/headers.js"
import { readNext, clearNextCookie } from "../../../../src/utilities/next.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  const challenge = await getCookie(context.request.headers.get("Cookie"), "webauthn_challenge_token")
  if (!challenge) {
    return new Response('<p class="result-negative">Authentication session expired. Please try again.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  let body: Record<string, unknown>
  try {
    body = (await context.request.json()) as Record<string, unknown>
  } catch {
    return new Response('<p class="result-negative">Invalid request body.</p>', { status: 400, headers: { "Content-Type": "text/html" } })
  }

  // Consume challenge token — also validates expiry and type atomically.
  const tokenResult = await consumeToken(dbClient, challenge, "webauthn_authentication_challenge")
  if (!tokenResult.success) {
    return new Response('<p class="result-negative">Authentication session expired. Please try again.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }
  const user_uuid = tokenResult.token.user_uuid

  // Fetch the stored credential by the ID the browser sent.
  const credentialId: unknown = body["id"]
  if (!credentialId || typeof credentialId !== "string") {
    return new Response('<p class="result-negative">Missing credential ID.</p>', { status: 400, headers: { "Content-Type": "text/html" } })
  }

  const passkeyResult = await getPasskeyByCredentialId(dbClient, credentialId)
  if (!passkeyResult.success) {
    return new Response('<p class="result-negative">Passkey not found. Please sign in with your password.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }
  const passkey = passkeyResult.passkey

  // Guard: credential must belong to the user whose challenge token we consumed.
  if (passkey.user_uuid !== user_uuid) {
    return new Response('<p class="result-negative">Passkey does not match account.</p>', {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })
  }

  const { rpID } = getRpConfig(context.env)
  const origin = context.env.APP_URL || `https://${rpID}`

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response: body as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.counter,
        transports: (passkey.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: true,
    })
  } catch (error) {
    console.error("Passkey authentication verification error:", error)
    return new Response('<p class="result-negative">Passkey verification failed. Please try again.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  if (!verification.verified) {
    return new Response('<p class="result-negative">Passkey could not be verified.</p>', {
      status: 401,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Update counter to block replays.
  await updatePasskeyCounter(dbClient, passkey.passkey_uuid, verification.authenticationInfo.newCounter)

  // Grant session directly — passkeys satisfy both authentication factors,
  // so the TOTP gate is intentionally skipped.
  const user_agent = context.request.headers.get("User-Agent") || ""
  const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
  const ip_country = context.request.headers.get("CF-IPCountry") || ""
  const sessionResult = await createSession(dbClient, user_uuid, user_agent, ip_address, ip_country)
  if (!sessionResult.success) {
    console.error("Error creating session after passkey auth:", sessionResult.error)
    return new Response('<p class="result-negative">Could not create session. Please try again.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }

  const sameSite = context.env.COOKIE_SAMESITE || "Lax"
  const secure = !!context.env.SECURE_COOKIE

  const clearChallenge = ["webauthn_challenge_token=", "HttpOnly", "Path=/", `SameSite=${sameSite}`, "Max-Age=0"]
  if (secure) clearChallenge.push("Secure")

  const sessionCookie = [
    `session_token=${sessionResult.session_id}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${sameSite}`,
    `Max-Age=${context.env.SESSION_MAX_AGE_SECONDS || 2592000}`,
  ]
  if (secure) sessionCookie.push("Secure")

  const headers = new Headers({ "Content-Type": "text/html" })
  headers.append("Set-Cookie", clearChallenge.join("; "))
  headers.append("Set-Cookie", sessionCookie.join("; "))
  // Honour the `login_next` cookie set by the root middleware, then clear it.
  const next = await readNext(context.request)
  if (next) headers.append("Set-Cookie", clearNextCookie(context.env))
  headers.set("HX-Redirect", next || "/account")
  return new Response(null, { status: 303, headers })
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
