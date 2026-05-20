import { currentPublicJwk, previousPublicJwk } from "../../src/oauth-keys.js"

// JSON Web Key Set — the public side of every signing key that may currently
// validate a JWT issued by this server. Always exposes the active key; during
// a rotation overlap window it also exposes the retired public key (held in
// OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC), so JWTs still in flight continue to
// verify until they expire.
//
// Reachable at https://<host>/.well-known/jwks.json — the standard JWKS URL
// that the (yet-to-land) /.well-known/openid-configuration document will
// advertise as `jwks_uri`.

export const onRequestGet: Handler = async ({ env }) => {
  const [current, previous] = await Promise.all([
    currentPublicJwk(env),
    previousPublicJwk(env),
  ])
  const keys = previous ? [current, previous] : [current]
  return new Response(JSON.stringify({ keys }), {
    headers: {
      "Content-Type": "application/jwk-set+json",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
