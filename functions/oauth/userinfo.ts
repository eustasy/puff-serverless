// OIDC UserInfo endpoint. The caller presents a JWT access token as a Bearer
// credential; on a valid token Puff returns the OIDC claims permitted by the
// `scope` claim baked into that token.
//
// Per OIDC §5.3.2, invalid_token responses MUST use the WWW-Authenticate
// header — the body is a courtesy. Success responses are JSON.

import { verifyJwt } from "../../src/oauth-jwt.js"
import { readUser } from "../../src/users.js"
import { readEmails } from "../../src/emails.js"
import { claimsForScopes, parseScope } from "../../src/oauth.js"

function bearerError(
  code: "invalid_token" | "insufficient_scope",
  description: string,
  status = 401
): Response {
  const challenge = `Bearer error="${code}", error_description="${description.replace(/"/g, "'")}"`
  return new Response(
    JSON.stringify({ error: code, error_description: description }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge,
      },
    }
  )
}

export const onRequestGet: Handler = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient
  if (!dbClient) {
    return bearerError("invalid_token", "Server error.", 500)
  }

  const auth = request.headers.get("Authorization") || ""
  if (!auth.startsWith("Bearer ")) {
    return bearerError("invalid_token", "Missing bearer token.")
  }
  const token = auth.slice("Bearer ".length).trim()

  const verified = await verifyJwt(env, token)
  if (!verified.success) {
    return bearerError("invalid_token", verified.message)
  }

  const { payload } = verified
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return bearerError("invalid_token", "Token expired.")
  }
  if (typeof payload.sub !== "string") {
    return bearerError("invalid_token", "Token missing subject.")
  }

  const userResult = await readUser(dbClient, payload.sub)
  if (userResult.error) {
    return bearerError("invalid_token", "User lookup failed.", 500)
  }
  if (!userResult.success) {
    return bearerError("invalid_token", "User not found.")
  }
  const user = userResult.user

  const scopes = parseScope(
    typeof payload.scope === "string" ? payload.scope : null
  )
  const { includeProfile, includeEmail } = claimsForScopes(scopes)

  const claims: Record<string, unknown> = { sub: user.user_uuid }
  if (includeProfile) {
    claims.name = user.user_name
  }
  if (includeEmail) {
    try {
      const emails = await readEmails(dbClient, user.user_uuid)
      // Prefer the primary verified address; fall back to any verified one.
      const primary =
        emails.find((e) => e.is_primary && e.is_verified) ||
        emails.find((e) => e.is_verified)
      if (primary) {
        claims.email = primary.email_address
        claims.email_verified = true
      }
    } catch (error) {
      console.error("userinfo: failed to read emails:", error)
      // Don't fail the whole response — email claims are optional.
    }
  }

  return new Response(JSON.stringify(claims), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
