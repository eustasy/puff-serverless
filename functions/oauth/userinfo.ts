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
import { readAppByClientId } from "../../src/apps.js"
import {
  buildEntitlementsClaim,
  buildMembershipsClaim,
  buildRolesClaim,
} from "../../src/oauth-claims.js"
import { bearerError } from "../../src/utilities/oauth-userinfo.js"

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
  const flags = claimsForScopes(scopes)

  const claims: Record<string, unknown> = { sub: user.user_uuid }
  if (flags.includeProfile) {
    claims.name = user.user_name
  }
  if (flags.includeEmail) {
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

  if (flags.includeMemberships) {
    const m = await buildMembershipsClaim(dbClient, user.user_uuid)
    if (m.success) claims["puff:memberships"] = m.memberships
  }
  if (flags.includeRoles) {
    const r = await buildRolesClaim(dbClient, user.user_uuid)
    if (r.success) claims["puff:roles"] = r.roles
  }
  if (flags.includeEntitlements) {
    // The access token's `client_id` + `org_uuid` claims tell us which app
    // and org this entitlements claim should be resolved against. Without
    // both, there's nothing meaningful to emit.
    const tokenClientId =
      typeof payload.client_id === "string" ? payload.client_id : null
    const tokenOrgUuid =
      typeof payload.org_uuid === "string" ? payload.org_uuid : null
    if (tokenClientId && tokenOrgUuid) {
      const appLookup = await readAppByClientId(dbClient, tokenClientId)
      if (appLookup.success) {
        const e = await buildEntitlementsClaim(
          dbClient,
          appLookup.app,
          user.user_uuid,
          tokenOrgUuid
        )
        if (e.success && e.entitlements) {
          claims["puff:entitlements"] = e.entitlements
        }
      }
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
