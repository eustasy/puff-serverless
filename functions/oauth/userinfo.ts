// OIDC UserInfo endpoint. The caller presents a JWT access token as a Bearer
// credential; on a valid token Puff returns the OIDC claims permitted by the
// `scope` claim baked into that token.
//
// Per OIDC §5.3.2, invalid_token responses MUST use the WWW-Authenticate
// header — the body is a courtesy. Success responses are JSON.

import { verifyJwt } from "../../src/oauth-jwt.js"
import { readUser } from "../../src/users.js"
import { bearerError, buildUserInfoClaims } from "../../src/utilities/oauth-userinfo.js"

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

  const claims = await buildUserInfoClaims(dbClient, userResult.user, payload)

  return new Response(JSON.stringify(claims), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

export const onRequest: Handler = async () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
