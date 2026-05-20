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
import { signJwt } from "../../src/oauth-jwt.js"
import { readEmails } from "../../src/emails.js"
import { readUser } from "../../src/users.js"

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 // 1 hour

interface ClientCreds {
  client_id: string
  client_secret: string
}

function parseBasicAuth(header: string | null): ClientCreds | null {
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

interface IdTokenContext {
  user_uuid: string
  client_id: string
  issuer: string
  scopes: string[]
  nonce: string | null
}

async function buildIdToken(
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

  if (ctx.scopes.includes("profile") || ctx.scopes.includes("email")) {
    const userResult = await readUser(dbClient, ctx.user_uuid)
    if (userResult.success) {
      if (ctx.scopes.includes("profile")) {
        payload.name = userResult.user.user_name
      }
      if (ctx.scopes.includes("email")) {
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
  return signJwt(env, payload)
}

async function buildAccessToken(
  env: Env,
  ctx: {
    user_uuid: string
    client_id: string
    issuer: string
    scopes: string[]
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(env, {
    iss: ctx.issuer,
    sub: ctx.user_uuid,
    aud: ctx.client_id,
    client_id: ctx.client_id,
    scope: ctx.scopes.join(" "),
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  })
}

interface TokenResponse {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
  refresh_token?: string
  id_token?: string
}

function jsonOk(body: TokenResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  })
}

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
    const access_token = await buildAccessToken(env, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
    })
    const id_token = await buildIdToken(env, dbClient, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      nonce: grant.nonce,
    })

    let refresh_token: string | undefined
    if (scopes.includes("offline_access")) {
      const refresh = await createRefreshToken(dbClient, {
        user_uuid: grant.user_uuid,
        app_uuid: app.app_uuid,
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
    return jsonOk(body)
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
      // reuse — invalidate the chain on a best-effort basis.
      await revokeRefreshTokenChain(dbClient, presented)
      return oauthErrorResponse("invalid_grant", consumed.message)
    }
    const grant = consumed.grant

    const scopes = grant.scopes
    const access_token = await buildAccessToken(env, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
    })
    const id_token = await buildIdToken(env, dbClient, {
      user_uuid: grant.user_uuid,
      client_id: app.client_id,
      issuer,
      scopes,
      nonce: null, // OIDC §12.1 — nonce is not re-issued during refresh.
    })
    const rotated = await createRefreshToken(dbClient, {
      user_uuid: grant.user_uuid,
      app_uuid: app.app_uuid,
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
    return jsonOk(body)
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
