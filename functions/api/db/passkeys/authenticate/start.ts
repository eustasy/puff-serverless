import { generateAuthenticationOptions } from "@simplewebauthn/server"
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server"
import { generateChallenge, isoBase64URL } from "@simplewebauthn/server/helpers"
import {
  getUserByUsername,
  listPasskeys,
  getRpConfig,
} from "../../../../../src/passkeys.js"
import { createWebAuthnToken } from "../../../../../src/tokens.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  let username: string | null = null
  try {
    const formData = await context.request.formData()
    const raw = formData.get("username")
    if (typeof raw === "string") username = raw.trim()
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (!username) {
    return new Response(JSON.stringify({ error: "Username is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { rpID } = getRpConfig(context.env)

  const challengeBytes = await generateChallenge()
  const challenge = isoBase64URL.fromBuffer(challengeBytes)

  // Look up user — enumeration-safe: generate a real challenge regardless, but
  // return empty allowCredentials if the user doesn't exist. The browser will
  // then present any resident credential it holds for this RP.
  const userResult = await getUserByUsername(dbClient, username)

  let allowCredentials: {
    id: string
    transports?: AuthenticatorTransportFuture[]
  }[] = []

  if (userResult.success) {
    const user_uuid = userResult.user_uuid
    const passkeysResult = await listPasskeys(dbClient, user_uuid)
    if (passkeysResult.success && passkeysResult.passkeys.length > 0) {
      allowCredentials = passkeysResult.passkeys.map((pk: PasskeyRow) => ({
        id: pk.credential_id,
        transports: (pk.transports ?? []) as AuthenticatorTransportFuture[],
      }))
    }

    const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const tokenResult = await createWebAuthnToken(
      dbClient,
      user_uuid,
      "webauthn_authentication_challenge",
      challenge,
      expires_at
    )
    if (tokenResult.error) {
      return new Response(
        JSON.stringify({ error: "Could not create authentication challenge." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
  } else {
    // User not found — no token stored; complete step will reject the missing
    // token. Still sets the challenge cookie and returns valid-looking options
    // to avoid revealing that the username doesn't exist.
  }

  const options = await generateAuthenticationOptions({
    rpID,
    challenge: challengeBytes as Uint8Array<ArrayBuffer>,
    allowCredentials,
    userVerification: "preferred",
    timeout: 300000,
  })

  const sameSite = context.env.COOKIE_SAMESITE || "Lax"
  const secure = !!context.env.SECURE_COOKIE
  const challengeCookie = [
    `webauthn_challenge_token=${challenge}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${sameSite}`,
    "Max-Age=300",
  ]
  if (secure) challengeCookie.push("Secure")

  return new Response(JSON.stringify(options), {
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
