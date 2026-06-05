import { claimsForScopes, parseScope } from "../oauth.js"
import { readEmails } from "../emails.js"
import { readAppByClientId } from "../apps.js"
import { buildEntitlementsClaim, buildMembershipsClaim, buildRolesClaim } from "../oauth-claims.js"
import type { JwtPayload } from "../oauth-jwt.js"

/** OIDC-compliant error response: includes a WWW-Authenticate Bearer challenge header as required by §5.3.2. */
export function bearerError(code: "invalid_token" | "insufficient_scope", description: string, status = 401): Response {
  const challenge = `Bearer error="${code}", error_description="${description.replace(/"/g, "'")}"`
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": challenge,
    },
  })
}

/**
 * Reads the user's preferred email claim pair, or null when none is emittable.
 * Prefers the primary verified address, falling back to any verified one. Fails
 * soft: a read error logs and returns null so the rest of the response stands.
 */
async function readEmailClaims(dbClient: DbClient, user_uuid: string): Promise<{ email: string; email_verified: true } | null> {
  try {
    const emails = await readEmails(dbClient, user_uuid)
    const primary = emails.find((e) => e.is_primary && e.is_verified) || emails.find((e) => e.is_verified)
    return primary ? { email: primary.email_address, email_verified: true } : null
  } catch (error) {
    console.error("userinfo: failed to read emails:", error)
    return null
  }
}

/**
 * Resolves the `puff:entitlements` claim from the token's app + org context.
 * Returns null (claim omitted) whenever a prerequisite is missing — the token
 * carries no client_id/org_uuid, the app can't be resolved, or there are no
 * entitlements — which flattens what was a four-deep nest in the handler.
 */
async function resolveEntitlementsClaim(dbClient: DbClient, payload: JwtPayload, user_uuid: string): Promise<unknown | null> {
  const tokenClientId = typeof payload.client_id === "string" ? payload.client_id : null
  const tokenOrgUuid = typeof payload.org_uuid === "string" ? payload.org_uuid : null
  if (!tokenClientId || !tokenOrgUuid) {
    return null
  }
  const appLookup = await readAppByClientId(dbClient, tokenClientId)
  if (!appLookup.success) {
    return null
  }
  const entitlements = await buildEntitlementsClaim(dbClient, appLookup.app, user_uuid, tokenOrgUuid)
  return entitlements.success && entitlements.entitlements ? entitlements.entitlements : null
}

/**
 * Assembles the OIDC UserInfo claim set permitted by the access token's scopes.
 * `sub` is always present; every other claim is gated by the matching scope.
 * Optional claims fail soft — a lookup miss or error omits that claim rather
 * than failing the whole response.
 */
export async function buildUserInfoClaims(dbClient: DbClient, user: UserRow, payload: JwtPayload): Promise<Record<string, unknown>> {
  const scopes = parseScope(typeof payload.scope === "string" ? payload.scope : null)
  const flags = claimsForScopes(scopes)

  const claims: Record<string, unknown> = { sub: user.user_uuid }

  if (flags.includeProfile) {
    claims.name = user.user_name
  }
  if (flags.includeEmail) {
    const emailClaims = await readEmailClaims(dbClient, user.user_uuid)
    if (emailClaims) {
      Object.assign(claims, emailClaims)
    }
  }
  if (flags.includeMemberships) {
    const m = await buildMembershipsClaim(dbClient, user.user_uuid)
    if (m.success) {
      claims["puff:memberships"] = m.memberships
    }
  }
  if (flags.includeRoles) {
    const r = await buildRolesClaim(dbClient, user.user_uuid)
    if (r.success) {
      claims["puff:roles"] = r.roles
    }
  }
  if (flags.includeEntitlements) {
    const entitlements = await resolveEntitlementsClaim(dbClient, payload, user.user_uuid)
    if (entitlements) {
      claims["puff:entitlements"] = entitlements
    }
  }

  return claims
}
