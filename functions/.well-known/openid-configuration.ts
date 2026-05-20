// OIDC Discovery document — the metadata clients fetch to learn the URLs and
// capabilities of this provider. The path `/.well-known/openid-configuration`
// is mandated by OpenID Connect Discovery 1.0 §4.1.

import { SUPPORTED_SCOPES } from "../../src/oauth.js"
import { JWT_ALG } from "../../src/oauth-keys.js"

export const onRequestGet: Handler = async ({ env }) => {
  const base = (env.APP_URL || "").replace(/\/$/, "")
  const doc = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [JWT_ALG],
    scopes_supported: SUPPORTED_SCOPES,
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "nonce",
      "name",
      "email",
      "email_verified",
    ],
  }
  return new Response(JSON.stringify(doc), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
