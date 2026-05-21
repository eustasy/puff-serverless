// Shared OAuth/OIDC helpers — scope parsing, PKCE verification, and the two
// RFC-mandated error-response shapes (JSON body for token/userinfo, redirect
// query params for authorize).

/**
 * The scope set Puff supports at the OAuth/OIDC layer. OIDC requires
 * `openid`; `profile` and `email` map to standard userinfo claims;
 * `offline_access` triggers issuance of a refresh token alongside the access
 * token. App-defined entitlement scopes (Phase 7 → App entitlements) will
 * extend this set later.
 */
export const SUPPORTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // Puff-specific scopes. `puff:memberships` adds the list of orgs the user
  // belongs to; `puff:roles` adds the user's org-level and team-level role
  // assignments (fixed puff roles, code-defined in src/permissions.ts);
  // `puff:entitlements` adds the entitlement claim for the org context the
  // OAuth grant was bound to (tier + permission flags resolved from the
  // KV layer under the requesting app's owner namespace).
  "puff:memberships",
  "puff:roles",
  "puff:entitlements",
] as const
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number]

const SUPPORTED_SCOPE_SET: ReadonlySet<string> = new Set(SUPPORTED_SCOPES)

/**
 * Standard OAuth 2.0 error codes (RFC 6749 §5.2 + OIDC §3.1.2.6). Used in the
 * `error` field of both JSON and redirect error responses.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"
  | "interaction_required"
  | "login_required"
  | "consent_required"

/**
 * Parse the space-separated `scope` parameter from an OAuth request. Drops
 * empties and de-duplicates. Returns the raw list — `validateScopes` decides
 * which of those Puff actually supports.
 */
export function parseScope(scope: string | null | undefined): string[] {
  if (!scope) return []
  const seen = new Set<string>()
  for (const part of scope.split(/\s+/)) {
    if (part.length > 0) seen.add(part)
  }
  return Array.from(seen)
}

/**
 * Split a parsed scope list into the ones Puff currently supports and the
 * ones it does not. The caller decides whether unknown scopes are a hard
 * error (invalid_scope) or a soft warning.
 */
export function validateScopes(scopes: string[]): {
  supported: string[]
  unsupported: string[]
} {
  const supported: string[] = []
  const unsupported: string[] = []
  for (const s of scopes) {
    if (SUPPORTED_SCOPE_SET.has(s)) {
      supported.push(s)
    } else {
      unsupported.push(s)
    }
  }
  return { supported, unsupported }
}

/**
 * Verify a PKCE code_verifier against the stored code_challenge. OAuth 2.1
 * forbids the deprecated `plain` method — Puff supports `S256` only:
 *
 *   code_challenge = base64url(sha256(code_verifier))
 *
 * Returns true on a match, false on any mismatch or unsupported method.
 */
export async function verifyPkce(
  code_verifier: string,
  code_challenge: string,
  code_challenge_method: string
): Promise<boolean> {
  if (code_challenge_method !== "S256") return false
  // RFC 7636: code_verifier is 43–128 chars from the unreserved set.
  if (code_verifier.length < 43 || code_verifier.length > 128) return false
  if (!/^[A-Za-z0-9._~-]+$/.test(code_verifier)) return false

  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code_verifier)
  )
  const bytes = new Uint8Array(hash)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const derived = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return derived === code_challenge
}

/**
 * JSON error response for the token / userinfo / revoke endpoints. Per RFC
 * 6749 §5.2 the body is `{ error, error_description? }` with 400 / 401 / 403
 * depending on the code; the caller picks the status.
 */
export function oauthErrorResponse(
  code: OAuthErrorCode,
  description?: string,
  status: number = 400,
  extraHeaders: Record<string, string> = {}
): Response {
  const body: Record<string, string> = { error: code }
  if (description) body.error_description = description
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      ...extraHeaders,
    },
  })
}

/**
 * Build a redirect URL carrying an OAuth error to a validated redirect_uri.
 * Per RFC 6749 §4.1.2.1 the error parameters go in the query (not the
 * fragment). `state` is echoed back when the caller had one. Use this only
 * AFTER validating that the redirect_uri is in the app's allowlist — never
 * redirect to an unvalidated URI.
 */
export function oauthRedirectErrorUrl(
  redirect_uri: string,
  code: OAuthErrorCode,
  state: string | null = null,
  description?: string
): string {
  const url = new URL(redirect_uri)
  url.searchParams.set("error", code)
  if (description) url.searchParams.set("error_description", description)
  if (state) url.searchParams.set("state", state)
  return url.toString()
}

/**
 * Map a granted scope set to the OIDC userinfo claim names that may appear in
 * the response. The caller pulls those claims out of the user/email records.
 */
export function claimsForScopes(scopes: string[]): {
  includeProfile: boolean
  includeEmail: boolean
  includeMemberships: boolean
  includeRoles: boolean
  includeEntitlements: boolean
} {
  return {
    includeProfile: scopes.includes("profile"),
    includeEmail: scopes.includes("email"),
    includeMemberships: scopes.includes("puff:memberships"),
    includeRoles: scopes.includes("puff:roles"),
    includeEntitlements: scopes.includes("puff:entitlements"),
  }
}
