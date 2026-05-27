import { claimsForScopes } from "../oauth.js"
import { signJwt } from "../oauth-jwt.js"
import { readEmails } from "../emails.js"
import { readUser } from "../users.js"
import {
  buildEntitlementsClaim,
  buildMembershipsClaim,
  buildRolesClaim,
} from "../oauth-claims.js"

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 // 1 hour

export interface ClientCreds {
  client_id: string
  client_secret: string
}

/** Parses an HTTP Basic Authorization header into client_id / client_secret, returning null on any malformation. */
export function parseBasicAuth(header: string | null): ClientCreds | null {
  if (!header || !header.startsWith("Basic ")) return null
  try {
    const decoded = atob(header.slice("Basic ".length).trim())
    const sep = decoded.indexOf(":")
    if (sep < 0) return null
    return {
      client_id: decodeURIComponent(decoded.slice(0, sep)),
      client_secret: decodeURIComponent(decoded.slice(sep + 1)),
    }
  } catch {
    return null
  }
}

export interface IdTokenContext {
  user_uuid: string
  client_id: string
  issuer: string
  scopes: string[]
  nonce: string | null
  app: { app_uuid: string; app_licensing_mode: AppRow["app_licensing_mode"] }
  org_uuid: string | null
}

/** Signs and returns a JWT ID token with OIDC claims for the requested scopes, or null if openid is not requested. */
export async function buildIdToken(
  env: Env,
  dbClient: DbClient,
  ctx: IdTokenContext
): Promise<string | null> {
  if (!ctx.scopes.includes("openid")) return null
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: ctx.issuer,
    sub: ctx.user_uuid,
    aud: ctx.client_id,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  }
  if (ctx.nonce) payload.nonce = ctx.nonce
  if (ctx.org_uuid) payload.org_uuid = ctx.org_uuid

  const flags = claimsForScopes(ctx.scopes)

  if (flags.includeProfile || flags.includeEmail) {
    const userResult = await readUser(dbClient, ctx.user_uuid)
    if (userResult.success) {
      if (flags.includeProfile) {
        payload.name = userResult.user.user_name
      }
      if (flags.includeEmail) {
        try {
          const emails = await readEmails(dbClient, ctx.user_uuid)
          const primary =
            emails.find((e) => e.is_primary && e.is_verified) ||
            emails.find((e) => e.is_verified)
          if (primary) {
            payload.email = primary.email_address
            payload.email_verified = true
          }
        } catch (error) {
          console.error("token: failed to read emails for id_token:", error)
        }
      }
    }
  }

  if (flags.includeMemberships) {
    const m = await buildMembershipsClaim(dbClient, ctx.user_uuid)
    if (m.success) payload["puff:memberships"] = m.memberships
  }
  if (flags.includeRoles) {
    const r = await buildRolesClaim(dbClient, ctx.user_uuid)
    if (r.success) payload["puff:roles"] = r.roles
  }
  if (flags.includeEntitlements) {
    const e = await buildEntitlementsClaim(
      dbClient,
      ctx.app,
      ctx.user_uuid,
      ctx.org_uuid
    )
    if (e.success && e.entitlements) {
      payload["puff:entitlements"] = e.entitlements
    }
  }

  return signJwt(env, payload)
}

/** Signs and returns a JWT access token carrying the scope claim and a unique jti. */
export async function buildAccessToken(
  env: Env,
  ctx: {
    user_uuid: string
    client_id: string
    issuer: string
    scopes: string[]
    org_uuid: string | null
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: ctx.issuer,
    sub: ctx.user_uuid,
    aud: ctx.client_id,
    client_id: ctx.client_id,
    scope: ctx.scopes.join(" "),
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  }
  if (ctx.org_uuid) {
    payload.org_uuid = ctx.org_uuid
  }
  return signJwt(env, payload)
}

export interface TokenResponse {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
  refresh_token?: string
  id_token?: string
}

/** Serialises a successful token response to JSON with the required no-store cache headers. */
export function jsonOk(body: TokenResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  })
}
