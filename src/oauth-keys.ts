// OAuth/OIDC signing-key infrastructure. ES256 (ECDSA P-256) keys; the private
// key lives in the OAUTH_SIGNING_KEY_PRIVATE secret as a JSON Web Key (JWK).
// The matching public key is derived from the private key at runtime, so only
// one binding is needed for the active key. During a rotation overlap window
// the prior public key is held in OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC (also a
// JWK) so still-valid JWTs signed by the retired key continue to verify.
//
// kid (key id) is the RFC 7638 thumbprint of the public JWK, so it is
// deterministic from the key material — no separate kid binding is needed.

export const JWT_ALG = "ES256" as const

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const

export type SigningJwk = JsonWebKey & {
  kty: "EC"
  crv: "P-256"
  x: string
  y: string
  d?: string
}

export type PublicJwkWithKid = {
  kty: "EC"
  crv: "P-256"
  x: string
  y: string
  kid: string
  use: "sig"
  alg: typeof JWT_ALG
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function parseSigningJwk(raw: string, field: string): SigningJwk {
  let jwk: unknown
  try {
    jwk = JSON.parse(raw)
  } catch {
    throw new Error(`${field} is not valid JSON`)
  }
  if (
    !jwk ||
    typeof jwk !== "object" ||
    (jwk as JsonWebKey).kty !== "EC" ||
    (jwk as JsonWebKey).crv !== "P-256" ||
    typeof (jwk as JsonWebKey).x !== "string" ||
    typeof (jwk as JsonWebKey).y !== "string"
  ) {
    throw new Error(`${field} is not an ES256 (EC P-256) JWK`)
  }
  return jwk as SigningJwk
}

function publicJwkFields(jwk: SigningJwk): {
  kty: "EC"
  crv: "P-256"
  x: string
  y: string
} {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}

/**
 * RFC 7638 JWK thumbprint — SHA-256 of the canonical JSON serialization of
 * the required EC members, base64url-encoded.
 */
export async function jwkThumbprint(jwk: SigningJwk): Promise<string> {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  })
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  )
  return base64UrlEncode(new Uint8Array(hash))
}

/**
 * Load the active private key as a non-extractable CryptoKey for signing.
 * Throws if OAUTH_SIGNING_KEY_PRIVATE is missing or malformed.
 */
export async function loadSigningKey(env: Env): Promise<CryptoKey> {
  const raw = env.OAUTH_SIGNING_KEY_PRIVATE
  if (!raw) {
    throw new Error("OAUTH_SIGNING_KEY_PRIVATE is not set")
  }
  const jwk = parseSigningJwk(raw, "OAUTH_SIGNING_KEY_PRIVATE")
  if (typeof jwk.d !== "string") {
    throw new Error(
      "OAUTH_SIGNING_KEY_PRIVATE is missing the private scalar `d`"
    )
  }
  return crypto.subtle.importKey("jwk", jwk, ECDSA_PARAMS, false, ["sign"])
}

/**
 * Import a public JWK as a CryptoKey for signature verification.
 */
export async function importVerificationKey(
  jwk: SigningJwk | PublicJwkWithKid
): Promise<CryptoKey> {
  const publicOnly = publicJwkFields(jwk as SigningJwk)
  return crypto.subtle.importKey("jwk", publicOnly, ECDSA_PARAMS, true, [
    "verify",
  ])
}

/**
 * Current public JWK (derived from the private key) with `kid`, `use`, `alg`
 * populated as required for the JWKS document.
 */
export async function currentPublicJwk(env: Env): Promise<PublicJwkWithKid> {
  const raw = env.OAUTH_SIGNING_KEY_PRIVATE
  if (!raw) {
    throw new Error("OAUTH_SIGNING_KEY_PRIVATE is not set")
  }
  const jwk = parseSigningJwk(raw, "OAUTH_SIGNING_KEY_PRIVATE")
  const kid = await jwkThumbprint(jwk)
  return { ...publicJwkFields(jwk), kid, use: "sig", alg: JWT_ALG }
}

/**
 * Previous public JWK (if a rotation overlap is in effect), with `kid`, `use`,
 * `alg` populated. Returns null when OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC is
 * absent or empty.
 */
export async function previousPublicJwk(
  env: Env
): Promise<PublicJwkWithKid | null> {
  const raw = env.OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC?.trim()
  if (!raw) return null
  const jwk = parseSigningJwk(raw, "OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC")
  const kid = await jwkThumbprint(jwk)
  return { ...publicJwkFields(jwk), kid, use: "sig", alg: JWT_ALG }
}
