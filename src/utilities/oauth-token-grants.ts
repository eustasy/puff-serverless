// Grant-flow orchestration for the OAuth token endpoint. Kept separate from
// oauth-token.ts (which holds the token *primitives* — JWT building, basic-auth
// parsing, response serialisation): this module is the per-grant-type control
// flow the `/oauth/token` controller dispatches into.

import { oauthErrorResponse, verifyPkce } from "../oauth.js"
import { consumeAuthorizationCode, consumeRefreshToken, createRefreshToken, revokeRefreshTokenChain } from "../oauth-grants.js"
import { checkoutFloatingSeat, releaseFloatingSeat } from "../app-floating-sessions.js"
import { ACCESS_TOKEN_TTL_SECONDS, buildAccessToken, buildIdToken, tokenResponse, type TokenResponse } from "./oauth-token.js"

/**
 * Floating-licence apps allocate a concurrency seat at token-issue time. Returns
 * an OAuth error Response to send back when the org context is missing or the
 * pool is exhausted, or null when a seat was claimed (or the app isn't
 * floating). `releaseOnFailure` frees a seat the caller may already hold before
 * denying — used on refresh so an exhausted pool isn't left pinned.
 */
async function ensureFloatingSeat(
  dbClient: DbClient,
  app: AppRow,
  org_uuid: string | null,
  user_uuid: string,
  releaseOnFailure: boolean
): Promise<Response | null> {
  if (app.app_licensing_mode !== "floating") {
    return null
  }
  if (!org_uuid) {
    return oauthErrorResponse("invalid_grant", "Floating-licence app requires an organisation context.")
  }
  const seat = await checkoutFloatingSeat(dbClient, app.app_uuid, org_uuid, user_uuid, ACCESS_TOKEN_TTL_SECONDS)
  if (!seat.success) {
    if (releaseOnFailure) {
      await releaseFloatingSeat(dbClient, app.app_uuid, org_uuid, user_uuid)
    }
    return oauthErrorResponse("access_denied", seat.message ?? "No floating seat available.")
  }
  return null
}

/**
 * Mints the access token and (when `openid` is requested) the ID token that both
 * grant flows return. The only per-flow difference is `nonce` — present on the
 * initial code exchange, null on refresh per OIDC §12.1.
 */
async function mintTokens(
  env: Env,
  dbClient: DbClient,
  ctx: { app: AppRow; issuer: string; user_uuid: string; scopes: string[]; org_uuid: string | null; nonce: string | null }
): Promise<{ access_token: string; id_token: string | null }> {
  const access_token = await buildAccessToken(env, {
    user_uuid: ctx.user_uuid,
    client_id: ctx.app.client_id,
    issuer: ctx.issuer,
    scopes: ctx.scopes,
    org_uuid: ctx.org_uuid,
  })
  const id_token = await buildIdToken(env, dbClient, {
    user_uuid: ctx.user_uuid,
    client_id: ctx.app.client_id,
    issuer: ctx.issuer,
    scopes: ctx.scopes,
    nonce: ctx.nonce,
    app: ctx.app,
    org_uuid: ctx.org_uuid,
  })
  return { access_token, id_token }
}

/**
 * `authorization_code` grant: validates PKCE against the consumed code, claims a
 * floating seat if the app needs one, then mints tokens. A refresh token is
 * issued only when `offline_access` was granted, and a mint failure there is
 * tolerated (logged) rather than failing the exchange.
 */
export async function handleAuthorizationCodeGrant(
  env: Env,
  dbClient: DbClient,
  app: AppRow,
  form: URLSearchParams,
  issuer: string
): Promise<Response> {
  const code = form.get("code") || ""
  const redirect_uri = form.get("redirect_uri") || ""
  const code_verifier = form.get("code_verifier") || ""
  if (!code || !redirect_uri || !code_verifier) {
    return oauthErrorResponse("invalid_request", "code, redirect_uri and code_verifier are required")
  }

  const consumed = await consumeAuthorizationCode(dbClient, code, app.app_uuid, redirect_uri)
  if (consumed.error) {
    return oauthErrorResponse("server_error", "DB error", 500)
  }
  if (!consumed.success) {
    return oauthErrorResponse("invalid_grant", consumed.message)
  }
  const grant = consumed.grant

  if (!grant.code_challenge || !grant.code_challenge_method) {
    return oauthErrorResponse("invalid_grant", "Authorization code is missing PKCE challenge")
  }
  const pkceOk = await verifyPkce(code_verifier, grant.code_challenge, grant.code_challenge_method)
  if (!pkceOk) {
    return oauthErrorResponse("invalid_grant", "PKCE verification failed")
  }

  const scopes = grant.scopes
  const grant_org_uuid = grant.org_uuid

  const seatError = await ensureFloatingSeat(dbClient, app, grant_org_uuid, grant.user_uuid, false)
  if (seatError) {
    return seatError
  }

  const { access_token, id_token } = await mintTokens(env, dbClient, {
    app,
    issuer,
    user_uuid: grant.user_uuid,
    scopes,
    org_uuid: grant_org_uuid,
    nonce: grant.nonce,
  })

  let refresh_token: string | undefined
  if (scopes.includes("offline_access")) {
    const refresh = await createRefreshToken(dbClient, {
      user_uuid: grant.user_uuid,
      app_uuid: app.app_uuid,
      org_uuid: grant_org_uuid,
      scopes,
      parent_grant_value: null,
    })
    if (refresh.success) {
      refresh_token = refresh.token
    } else {
      console.error("token: refresh token mint failed:", refresh.message)
    }
  }

  const body: TokenResponse = {
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  }
  if (refresh_token) body.refresh_token = refresh_token
  if (id_token) body.id_token = id_token
  return tokenResponse(body)
}

/**
 * `refresh_token` grant: consumes (rotates) the presented token. A consume
 * failure is treated as suspected reuse and revokes the whole chain. The
 * floating seat is heartbeat-or-allocated, freeing any held seat on an exhausted
 * pool. Rotation always issues a new refresh token; a rotation failure is a hard
 * 500.
 */
export async function handleRefreshTokenGrant(
  env: Env,
  dbClient: DbClient,
  app: AppRow,
  form: URLSearchParams,
  issuer: string
): Promise<Response> {
  const presented = form.get("refresh_token") || ""
  if (!presented) {
    return oauthErrorResponse("invalid_request", "refresh_token is required")
  }
  const consumed = await consumeRefreshToken(dbClient, presented, app.app_uuid)
  if (consumed.error) {
    return oauthErrorResponse("server_error", "DB error", 500)
  }
  if (!consumed.success) {
    // Could be expired, wrong app, or already used. The last is suspected reuse —
    // invalidate the chain so a leaked token can't keep being exchanged.
    await revokeRefreshTokenChain(dbClient, presented)
    return oauthErrorResponse("invalid_grant", consumed.message)
  }
  const grant = consumed.grant
  const scopes = grant.scopes
  const grant_org_uuid = grant.org_uuid

  const seatError = await ensureFloatingSeat(dbClient, app, grant_org_uuid, grant.user_uuid, true)
  if (seatError) {
    return seatError
  }

  const { access_token, id_token } = await mintTokens(env, dbClient, {
    app,
    issuer,
    user_uuid: grant.user_uuid,
    scopes,
    org_uuid: grant_org_uuid,
    nonce: null, // OIDC §12.1 — nonce is not re-issued during refresh.
  })

  const rotated = await createRefreshToken(dbClient, {
    user_uuid: grant.user_uuid,
    app_uuid: app.app_uuid,
    org_uuid: grant_org_uuid,
    scopes,
    parent_grant_value: grant.grant_value,
  })
  if (rotated.error || !rotated.success) {
    return oauthErrorResponse("server_error", "Could not rotate token", 500)
  }

  const body: TokenResponse = {
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
    refresh_token: rotated.token,
  }
  if (id_token) body.id_token = id_token
  return tokenResponse(body)
}
