import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server"
import {
  savePasskey,
  listPasskeys,
  getRpConfig,
} from "../../../../../../src/passkeys.js"
import { consumeToken } from "../../../../../../src/tokens.js"
import { getCookie } from "../../../../../../src/utilities/headers.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const challenge = await getCookie(
    context.request.headers.get("Cookie"),
    "webauthn_challenge_token"
  )
  if (!challenge) {
    return new Response(
      '<p class="result-negative">Registration session expired. Please try again.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return new Response(
      '<p class="result-negative">Invalid request body.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  const tokenResult = await consumeToken(
    dbClient,
    challenge,
    "webauthn_registration_challenge"
  )
  if (!tokenResult.success) {
    return new Response(
      '<p class="result-negative">Registration session expired. Please try again.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  const { rpID, rpName: _rpName } = getRpConfig(context.env)
  const origin = context.env.APP_URL || `https://${rpID}`

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: body as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    })
  } catch (error) {
    console.error("Passkey registration verification error:", error)
    return new Response(
      '<p class="result-negative">Passkey verification failed. Please try again.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  if (!verification.verified || !verification.registrationInfo) {
    return new Response(
      '<p class="result-negative">Passkey registration could not be verified.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  const { credential } = verification.registrationInfo

  const existingResult = await listPasskeys(dbClient, user_uuid)
  const count = existingResult.success ? existingResult.passkeys.length : 0
  const name = `Passkey ${count + 1}`

  const saveResult = await savePasskey(
    dbClient,
    user_uuid,
    credential.id,
    credential.publicKey,
    credential.counter,
    credential.transports,
    name
  )
  if (saveResult.error || !saveResult.success) {
    return new Response(
      '<p class="result-negative">Failed to save passkey. Please try again.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }

  const sameSite = context.env.COOKIE_SAMESITE || "Lax"
  const secure = !!context.env.SECURE_COOKIE
  const clearCookie = [
    "webauthn_challenge_token=",
    "HttpOnly",
    "Path=/",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ]
  if (secure) clearCookie.push("Secure")

  return new Response(
    '<p class="result-positive">Passkey registered successfully.</p>',
    {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Set-Cookie": clearCookie.join("; "),
        "HX-Trigger": "passkeysChanged",
      },
    }
  )
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
