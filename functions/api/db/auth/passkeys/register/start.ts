import { generateRegistrationOptions } from "@simplewebauthn/server"
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server"
import { generateChallenge, isoBase64URL } from "@simplewebauthn/server/helpers"
import { listPasskeys, getRpConfig } from "../../../../../../src/passkeys.js"
import { createWebAuthnToken } from "../../../../../../src/tokens.js"
import { readUser } from "../../../../../../src/users.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const userResult = await readUser(dbClient, user_uuid)
  if (!userResult.success) {
    return new Response('<p class="result-negative">Could not load user details.</p>', {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const passkeysResult = await listPasskeys(dbClient, user_uuid)
  if (passkeysResult.error || !passkeysResult.success) {
    return new Response(JSON.stringify({ error: "Could not load existing passkeys." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { rpID, rpName } = getRpConfig(context.env)
  const origin = context.env.APP_URL || `https://${rpID}`

  const challengeBytes = await generateChallenge()
  const challenge = isoBase64URL.fromBuffer(challengeBytes)

  const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const tokenResult = await createWebAuthnToken(dbClient, user_uuid, "webauthn_registration_challenge", challenge, expires_at)
  if (tokenResult.error) {
    return new Response(JSON.stringify({ error: "Could not create registration challenge." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const existingCredentials = passkeysResult.passkeys.map((pk: PasskeyRow) => ({
    id: pk.credential_id,
    transports: (pk.transports ?? []) as AuthenticatorTransportFuture[],
  }))

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: userResult.user.user_name,
    userDisplayName: userResult.user.user_name,
    userID: new TextEncoder().encode(user_uuid) as Uint8Array<ArrayBuffer>,
    challenge: challengeBytes as Uint8Array<ArrayBuffer>,
    excludeCredentials: existingCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  })

  const sameSite = context.env.COOKIE_SAMESITE || "Lax"
  const secure = !!context.env.SECURE_COOKIE
  const challengeCookie = [`webauthn_challenge_token=${challenge}`, "HttpOnly", "Path=/", `SameSite=${sameSite}`, "Max-Age=300"]
  if (secure) challengeCookie.push("Secure")

  return new Response(JSON.stringify({ options, origin }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": challengeCookie.join("; "),
    },
  })
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
