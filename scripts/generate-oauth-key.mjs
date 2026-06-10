#!/usr/bin/env node
// Generate an ES256 (ECDSA P-256) keypair for the OAuth/OIDC signing
// infrastructure. Prints the private JWK plus the matching public JWK and
// kid for reference.
//
// The active key normally lives in the `KV_OAUTH_KEYS` namespace and is
// rotated automatically (weekly) by the cron in `src/cron.ts`. This script
// is for first-time seeding only — paste the printed JWK into either the
// KV `oauth:keys:active` entry or the legacy `OAUTH_SIGNING_KEY_PRIVATE`
// secret. See docs/Operations.md → OAuth signing-key rotation.
//
// Usage:  node scripts/generate-oauth-key.mjs

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])

const privateJwk = await crypto.subtle.exportKey("jwk", privateKey)
const publicJwk = await crypto.subtle.exportKey("jwk", publicKey)

function base64UrlEncode(bytes) {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// RFC 7638 JWK thumbprint — matches src/oauth-keys.ts#jwkThumbprint.
const canonical = JSON.stringify({
  crv: publicJwk.crv,
  kty: publicJwk.kty,
  x: publicJwk.x,
  y: publicJwk.y,
})
const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
const kid = base64UrlEncode(new Uint8Array(hash))

const privateJwkCompact = JSON.stringify({
  kty: privateJwk.kty,
  crv: privateJwk.crv,
  x: privateJwk.x,
  y: privateJwk.y,
  d: privateJwk.d,
})

const publicJwkForReference = {
  kty: publicJwk.kty,
  crv: publicJwk.crv,
  x: publicJwk.x,
  y: publicJwk.y,
  kid,
  use: "sig",
  alg: "ES256",
}

console.log("kid:", kid)
console.log("")
console.log("Public JWK (derived at runtime; shown for reference only):")
console.log(JSON.stringify(publicJwkForReference, null, 2))
console.log("")
console.log("Private JWK:")
console.log("")
console.log("  " + privateJwkCompact)
console.log("")
console.log("To seed KV (production):")
console.log("")
console.log(
  '  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "{\\"jwk\\": ' +
    privateJwkCompact +
    ', \\"kid\\": \\"' +
    kid +
    '\\", \\"created_at\\": \\"$NOW\\"}" | \\'
)
console.log("    npx wrangler kv key put --binding=KV_OAUTH_KEYS oauth:keys:active --pipe")
console.log("")
console.log("To seed the legacy Wrangler secret (migration / fallback):")
console.log("")
console.log("  echo '" + privateJwkCompact + "' \\")
console.log("    | npx wrangler secret put OAUTH_SIGNING_KEY_PRIVATE")
console.log("")
console.log("For local development add the same JSON to `.env` as OAUTH_SIGNING_KEY_PRIVATE.")
console.log("")
console.log("Rotation in production is automatic (weekly, via the cron in src/cron.ts). To")
console.log("rotate on demand, POST to /api/admin/oauth-keys/rotate.")
