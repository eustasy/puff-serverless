// OAuth 2.1 / OIDC Token endpoint. Exchanges an authorization code (with
// PKCE) for an access token + ID token + refresh token, OR rotates a refresh
// token. Confidential clients only — the `client_secret` is required on every
// request and authenticated via HTTP Basic (preferred) or body params.
//
// Responses:
//   200 + { access_token, token_type:"Bearer", expires_in, refresh_token?, id_token?, scope }
//   400 / 401 + { error, error_description? }   per RFC 6749 §5.2

import { oauthErrorResponse, verifyPkce } from "../../src/oauth.js"
import { verifyAppCredentials } from "../../src/apps.js"
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  createRefreshToken,
  revokeRefreshTokenChain,
} from "../../src/oauth-grants.js"
import {
  checkoutFloatingSeat,
  releaseFloatingSeat,
} from "../../src/app-floating-sessions.js"
import {
  ACCESS_TOKEN_TTL_SECONDS,
  buildAccessToken,
  buildIdToken,
  tokenResponse,
  parseBasicAuth,
  type TokenResponse,
} from "../../src/utilities/oauth-token.js"

export const onRequestPost: Handler = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient
  if (!dbClient) {
    return oauthErrorResponse("server_error", "Database unavailable", 500)
  }

  const contentType = request.headers.get("Content-Type") || ""
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthErrorResponse(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded"
    )
  }

  let form: URLSearchParams
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return oauthErrorResponse("invalid_request", "Could not parse body")
  }

  const basic = parseBasicAuth(request.headers.get("Authorization"))
  const client_id = basic?.client_id || form.get("client_id") || ""
  const client_secret = basic?.client_secret || form.get("client_secret") || ""
  if (!client_id || !client_secret) {
    return oauthErrorResponse(
      "invalid_client",
      "Client credentials required",
      401,
      { "WWW-Authenticate": 'Basic realm="oauth"' }
    )
  }

  const creds = await verifyAppCredentials(dbClient, client_id, client_secret)
  if (creds.error || !creds.success || !creds.verified || !creds.app) {
    return oauthErrorResponse(
      "invalid_client",
      "Invalid client credentials",
      401,
      { "WWW-Authenticate": 'Basic realm="oauth"' }
    )
  }
  const app = creds.app

  const grant_type = form.get("grant_type") || ""
  const issuer = (env.APP_URL || "").replace(/\/$/, "")

  if (grant_type === "authorization_code") {
    const code = form.get("code") || ""
    const redirect_uri = form.get("redirect_uri") || ""
    const code_verifier = form.get("code_verifier") || ""
    if (!code || !redirect_uri || !code_verifier) {
      return oauthErrorResponse(
        "invalid_request",
        "code, redirect_uri and code_verifier are required"
      )
    }

    const consumed = await consumeAuthorizationCode(
      dbClient,
      code,
      app.app_uuid,
      redirect_uri
    )
    if (consumed.error) {
      return oauthErrorResponse("server_error", "DB error", 500)
    }
    if (!consumed.success) {
      return oauthErrorResponse("invalid_grant", consumed.message)
    }
    const grant = consumed.grant

    if (!grant.code_challenge || !grant.code_challenge_method) {
      return oauthErrorResponse(
        "invalid_grant",
        "Authorization code is missing PKCE challenge"
      )
    }
    const pkceOk = await verifyPkce(
      code_verifier,
      grant.code_challenge,
      grant.code_challenge_method
    )
    if (!pkceOk) {
      return oauthErrorResponse("invalid_grant", "PKCE verification failed")
    }

    const scopes = grant.scopes
    const grant_org_uuid = grant.org_uuid

    // Floating apps allocate a seat at token-issue time. If the org's pool is
    // already full, the OAuth contract says we deny — the user might retry
    // later when a seat frees up.
    if (app.app_licensing_mode === "floating") {
      if (!grant_org_uuid) {
        return oauthErrorResponse(
          "invalid_grant",
          "Floating-licence app requires an organisation context."
        )
      }
      const seat = await checkoutFloatingSeat(
        dbClient,
        app.app_uuid,
        grant_org_uuid,
        grant.user_uuid,
        ACCESS_TOKEN_TTL_SECONDS
      )
      if (!seat.success) {
        return oauthErrorResponse(
          "access_denied",
          seat.message ?? "No floating seat available."
        )
      }
    }

    const access_token = await buildAccessToken(env, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      org_uuid: grant_org_uuid,
    })
    const id_token = await buildIdToken(env, dbClient, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      nonce: grant.nonce,
      app,
      org_uuid: grant_org_uuid,
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

  if (grant_type === "refresh_token") {
    const presented = form.get("refresh_token") || ""
    if (!presented) {
      return oauthErrorResponse("invalid_request", "refresh_token is required")
    }
    const consumed = await consumeRefreshToken(
      dbClient,
      presented,
      app.app_uuid
    )
    if (consumed.error) {
      return oauthErrorResponse("server_error", "DB error", 500)
    }
    if (!consumed.success) {
      // Could be: expired, wrong app, already used. The last case is suspected
      // reuse — invalidate the chain AND, on a best-effort basis, release any
      // floating seat the chain was holding so an attacker doesn't get to
      // pin a slot.
      await revokeRefreshTokenChain(dbClient, presented)
      return oauthErrorResponse("invalid_grant", consumed.message)
    }
    const grant = consumed.grant
    const scopes = grant.scopes
    const grant_org_uuid = grant.org_uuid

    if (app.app_licensing_mode === "floating") {
      if (!grant_org_uuid) {
        return oauthErrorResponse(
          "invalid_grant",
          "Floating-licence app requires an organisation context."
        )
      }
      // Heartbeat-or-allocate: the existing seat is bumped, or a new one is
      // claimed if the previous expired. Pool-exhausted at refresh time is
      // the same denial path as at code exchange.
      const seat = await checkoutFloatingSeat(
        dbClient,
        app.app_uuid,
        grant_org_uuid,
        grant.user_uuid,
        ACCESS_TOKEN_TTL_SECONDS
      )
      if (!seat.success) {
        // Best-effort: free anything we have for this user so the pool isn't
        // stuck.
        await releaseFloatingSeat(
          dbClient,
          app.app_uuid,
          grant_org_uuid,
          grant.user_uuid
        )
        return oauthErrorResponse(
          "access_denied",
          seat.message ?? "No floating seat available."
        )
      }
    }

    const access_token = await buildAccessToken(env, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      org_uuid: grant_org_uuid,
    })
    const id_token = await buildIdToken(env, dbClient, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      nonce: null, // OIDC §12.1 — nonce is not re-issued during refresh.
      app,
      org_uuid: grant_org_uuid,
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

  return oauthErrorResponse(
    "unsupported_grant_type",
    `grant_type "${grant_type}" is not supported`
  )
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
