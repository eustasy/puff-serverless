// OAuth/OIDC signing-key infrastructure. ES256 (ECDSA P-256) keys live in
// Cloudflare KV (`KV_OAUTH_KEYS`) so the rotation cron in
// `src/oauth-keys-rotation.ts` can promote a fresh keypair at runtime —
// Wrangler secrets are immutable to the running Worker.
//
//   oauth:keys:active   { jwk: <private JWK>, kid, created_at }
//   oauth:keys:retired  { jwk: <public  JWK>, kid, retired_at }   (TTL'd)
//
// During the brief overlap after a rotation the retired public JWK stays in
// JWKS so JWTs signed by the previous key continue to verify until they
// expire. KV writes the retired entry with an `expirationTtl` (2 hours = 1h
// longest-lived JWT + 1h safety margin) so it self-cleans.
//
// Env-var fallback (`OAUTH_SIGNING_KEY_PRIVATE` /
// `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC`) is preserved deliberately: during the
// KV migration deploy the operator seeds KV from the existing secrets, but
// the fallback keeps the Worker functional even if KV is empty or the
// binding is missing in local dev. After ≥ one successful rotation in
// production the env-var path can be removed.
//
// kid (key id) is the RFC 7638 thumbprint of the public JWK, so it is
// deterministic from the key material — no separate kid storage is needed.

export const JWT_ALG = "ES256" as const

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const

const KV_KEY_ACTIVE = "oauth:keys:active"
const KV_KEY_RETIRED = "oauth:keys:retired"

// KV reads are eventually consistent (~60s globally). Cache the parsed
// material per isolate for a similar window — verification tolerates a
// slightly stale read because the previous key is still in JWKS during the
// overlap, and signing tolerates it because both keys verify anywhere.
const CACHE_TTL_MS = 60_000

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

// Persisted KV-entry shapes. Written by `oauth-keys-rotation.ts`; read here.
export interface StoredActiveKey {
  jwk: SigningJwk // includes `d` (private scalar)
  kid: string
  created_at: string
}
export interface StoredRetiredKey {
  jwk: SigningJwk // public-only — `d` deliberately stripped at write time
  kid: string
  retired_at: string
}

interface CacheEntry<T> {
  value: T | null
  fetched_at: number
}

let activeCache: CacheEntry<StoredActiveKey> | null = null
let retiredCache: CacheEntry<StoredRetiredKey> | null = null

/**
 * Clear the module-level KV cache. Called immediately after the rotation
 * cron writes new material so the next read reflects it without waiting up
 * to `CACHE_TTL_MS`.
 */
export function _resetOAuthKeyCache(): void {
  activeCache = null
  retiredCache = null
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function parseSigningJwk(raw: unknown, field: string): SigningJwk {
  let jwk: unknown = raw
  if (typeof raw === "string") {
    try {
      jwk = JSON.parse(raw)
    } catch {
      throw new Error(`${field} is not valid JSON`)
    }
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

async function readActiveStored(env: Env): Promise<StoredActiveKey | null> {
  const now = Date.now()
  // Only the KV path is cached — KV reads are a network round-trip worth
  // memoising. The env-var fallback is a cheap in-memory JSON.parse, so it
  // is read fresh every time; caching it would also be wrong, since two
  // different envs share this module-level cache.
  if (
    env.KV_OAUTH_KEYS &&
    activeCache &&
    now - activeCache.fetched_at < CACHE_TTL_MS
  ) {
    return activeCache.value
  }
  let value: StoredActiveKey | null = null

  // KV is the source of truth. Try it first; tolerate a missing binding so
  // local-dev without KV still works on the env-var fallback below.
  if (env.KV_OAUTH_KEYS) {
    const stored = await env.KV_OAUTH_KEYS.get<StoredActiveKey>(
      KV_KEY_ACTIVE,
      "json"
    )
    if (stored) {
      const jwk = parseSigningJwk(stored.jwk, `${KV_KEY_ACTIVE}.jwk`)
      if (typeof jwk.d !== "string") {
        throw new Error(`${KV_KEY_ACTIVE} is missing the private scalar 'd'`)
      }
      value = { ...stored, jwk, kid: stored.kid ?? (await jwkThumbprint(jwk)) }
    }
  }

  // Migration fallback: until the operator seeds KV from the secret, the
  // Worker keeps signing with the env-var key.
  if (!value && env.OAUTH_SIGNING_KEY_PRIVATE) {
    const jwk = parseSigningJwk(
      env.OAUTH_SIGNING_KEY_PRIVATE,
      "OAUTH_SIGNING_KEY_PRIVATE"
    )
    if (typeof jwk.d !== "string") {
      throw new Error(
        "OAUTH_SIGNING_KEY_PRIVATE is missing the private scalar `d`"
      )
    }
    value = {
      jwk,
      kid: await jwkThumbprint(jwk),
      created_at: "env-var-fallback",
    }
  }

  if (env.KV_OAUTH_KEYS) activeCache = { value, fetched_at: now }
  return value
}

async function readRetiredStored(env: Env): Promise<StoredRetiredKey | null> {
  const now = Date.now()
  // Cached only on the KV path — see `readActiveStored` for the rationale.
  if (
    env.KV_OAUTH_KEYS &&
    retiredCache &&
    now - retiredCache.fetched_at < CACHE_TTL_MS
  ) {
    return retiredCache.value
  }
  let value: StoredRetiredKey | null = null

  if (env.KV_OAUTH_KEYS) {
    const stored = await env.KV_OAUTH_KEYS.get<StoredRetiredKey>(
      KV_KEY_RETIRED,
      "json"
    )
    if (stored) {
      const jwk = parseSigningJwk(stored.jwk, `${KV_KEY_RETIRED}.jwk`)
      value = { ...stored, jwk, kid: stored.kid ?? (await jwkThumbprint(jwk)) }
    }
  }

  if (!value) {
    const raw = env.OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC?.trim()
    if (raw) {
      const jwk = parseSigningJwk(raw, "OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC")
      value = {
        jwk,
        kid: await jwkThumbprint(jwk),
        retired_at: "env-var-fallback",
      }
    }
  }

  if (env.KV_OAUTH_KEYS) retiredCache = { value, fetched_at: now }
  return value
}

/**
 * Load the active private key as a non-extractable CryptoKey for signing.
 * Throws if neither KV nor the env-var fallback has a key, or if what is
 * there is malformed.
 */
export async function loadSigningKey(env: Env): Promise<CryptoKey> {
  const stored = await readActiveStored(env)
  if (!stored) {
    throw new Error(
      "No active signing key found (KV_OAUTH_KEYS:oauth:keys:active and " +
        "OAUTH_SIGNING_KEY_PRIVATE both empty)"
    )
  }
  return crypto.subtle.importKey("jwk", stored.jwk, ECDSA_PARAMS, false, [
    "sign",
  ])
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
 * Current public JWK (derived from the active private key) with `kid`,
 * `use`, `alg` populated as required for the JWKS document.
 */
export async function currentPublicJwk(env: Env): Promise<PublicJwkWithKid> {
  const stored = await readActiveStored(env)
  if (!stored) {
    throw new Error(
      "No active signing key found (KV_OAUTH_KEYS:oauth:keys:active and " +
        "OAUTH_SIGNING_KEY_PRIVATE both empty)"
    )
  }
  return {
    ...publicJwkFields(stored.jwk),
    kid: stored.kid,
    use: "sig",
    alg: JWT_ALG,
  }
}

/**
 * Previous public JWK (if a rotation overlap is in effect), with `kid`,
 * `use`, `alg` populated. Returns null when no retired key is held in KV
 * and the env-var fallback is empty.
 */
export async function previousPublicJwk(
  env: Env
): Promise<PublicJwkWithKid | null> {
  const stored = await readRetiredStored(env)
  if (!stored) return null
  return {
    ...publicJwkFields(stored.jwk),
    kid: stored.kid,
    use: "sig",
    alg: JWT_ALG,
  }
}
