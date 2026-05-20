#!/usr/bin/env node
// Generate an ES256 (ECDSA P-256) keypair for the OAuth/OIDC signing
// infrastructure. Prints the private JWK to paste into
// `wrangler secret put OAUTH_SIGNING_KEY_PRIVATE`, plus the matching public
// JWK and kid for reference.
//
// The public key is NOT stored as a separate binding — `src/oauth-keys.ts`
// derives it from the private JWK at runtime. The previous public JWK is only
// needed during a rotation overlap window, in OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC.
//
// Usage:  node scripts/generate-oauth-key.mjs
//
// Then:   echo '<paste private JWK>' | npx wrangler secret put OAUTH_SIGNING_KEY_PRIVATE

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
)

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
const hash = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(canonical)
)
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
console.log("Private JWK — set as the OAUTH_SIGNING_KEY_PRIVATE secret:")
console.log("")
console.log("  echo '" + privateJwkCompact + "' \\")
console.log("    | npx wrangler secret put OAUTH_SIGNING_KEY_PRIVATE")
console.log("")
console.log(
  "For local development add the same JSON to `.env` as OAUTH_SIGNING_KEY_PRIVATE."
)
console.log("")
console.log("Rotation: when rotating, run this script again and:")
console.log("  1. copy the OLD public JWK (without `kid`/`use`/`alg`) into the")
console.log("     OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC binding for the overlap")
console.log("     window (delete it after the longest-lived JWT has expired);")
console.log("  2. push the NEW private JWK as OAUTH_SIGNING_KEY_PRIVATE.")
