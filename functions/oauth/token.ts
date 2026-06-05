// OAuth 2.1 / OIDC Token endpoint. Exchanges an authorization code (with
// PKCE) for an access token + ID token + refresh token, OR rotates a refresh
// token. Confidential clients only — the `client_secret` is required on every
// request and authenticated via HTTP Basic (preferred) or body params.
//
// Responses:
//   200 + { access_token, token_type:"Bearer", expires_in, refresh_token?, id_token?, scope }
//   400 / 401 + { error, error_description? }   per RFC 6749 §5.2

import { oauthErrorResponse } from "../../src/oauth.js"
import { verifyAppCredentials } from "../../src/apps.js"
import { parseBasicAuth } from "../../src/utilities/oauth-token.js"
import { handleAuthorizationCodeGrant, handleRefreshTokenGrant } from "../../src/utilities/oauth-token-grants.js"

export const onRequestPost: Handler = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient
  if (!dbClient) {
    return oauthErrorResponse("server_error", "Database unavailable", 500)
  }

  const contentType = request.headers.get("Content-Type") || ""
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthErrorResponse("invalid_request", "Content-Type must be application/x-www-form-urlencoded")
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
    return oauthErrorResponse("invalid_client", "Client credentials required", 401, { "WWW-Authenticate": 'Basic realm="oauth"' })
  }

  const creds = await verifyAppCredentials(dbClient, client_id, client_secret)
  if (creds.error || !creds.success || !creds.verified || !creds.app) {
    return oauthErrorResponse("invalid_client", "Invalid client credentials", 401, { "WWW-Authenticate": 'Basic realm="oauth"' })
  }
  const app = creds.app

  const grant_type = form.get("grant_type") || ""
  const issuer = (env.APP_URL || "").replace(/\/$/, "")

  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(env, dbClient, app, form, issuer)
  }
  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(env, dbClient, app, form, issuer)
  }
  return oauthErrorResponse("unsupported_grant_type", `grant_type "${grant_type}" is not supported`)
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
