// JWT sign + verify primitives for the OAuth/OIDC provider. ES256 only —
// see `oauth-keys.ts` for the key infrastructure.
//
// Tokens are the compact JWS form `<header>.<payload>.<signature>`, all parts
// base64url-encoded. The ECDSA signature is the raw R || S concatenation
// (64 bytes for P-256), which matches the JWA `ES256` spec — no DER unwrap.

import {
  JWT_ALG,
  currentPublicJwk,
  importVerificationKey,
  loadSigningKey,
  previousPublicJwk,
  type PublicJwkWithKid,
} from "./oauth-keys.js"

const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const

interface JwtHeader {
  alg: typeof JWT_ALG
  typ: "JWT"
  kid: string
}

export interface JwtPayload {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  iat?: number
  nbf?: number
  jti?: string
  [claim: string]: unknown
}

export type VerifyResult =
  | { success: true; payload: JwtPayload; kid: string }
  | { success: false; message: string }

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64UrlEncodeJson(obj: object): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(obj)))
}

function base64UrlDecodeJson<T = unknown>(input: string): T {
  const bytes = base64UrlDecodeToBytes(input)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/**
 * Sign a JWT payload with the active signing key. The header `kid` is set to
 * the RFC 7638 thumbprint of the current public JWK so JWKS consumers can
 * match keys.
 */
export async function signJwt(env: Env, payload: JwtPayload): Promise<string> {
  const [key, publicJwk] = await Promise.all([
    loadSigningKey(env),
    currentPublicJwk(env),
  ])
  const header: JwtHeader = { alg: JWT_ALG, typ: "JWT", kid: publicJwk.kid }
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`
  const signature = await crypto.subtle.sign(
    ECDSA_SIGN,
    key,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`
}

async function findVerificationKey(
  env: Env,
  kid: string
): Promise<PublicJwkWithKid | null> {
  const current = await currentPublicJwk(env)
  if (current.kid === kid) return current
  const previous = await previousPublicJwk(env)
  if (previous && previous.kid === kid) return previous
  return null
}

/**
 * Verify a JWT against the current or (during rotation) previous public key
 * advertised in JWKS. On success returns `{ payload, kid }`; on any failure
 * returns a structured `{ success: false, message }` envelope — no throws.
 *
 * `exp` / `nbf` claims are NOT validated here; the caller decides what
 * lifetime/clock-skew policy to apply to the returned payload.
 */
export async function verifyJwt(
  env: Env,
  token: string
): Promise<VerifyResult> {
  const parts = token.split(".")
  if (parts.length !== 3) {
    return { success: false, message: "JWT must have three parts" }
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ]

  let header: JwtHeader
  try {
    header = base64UrlDecodeJson<JwtHeader>(encodedHeader)
  } catch {
    return { success: false, message: "JWT header is not valid JSON" }
  }
  if (header.alg !== JWT_ALG) {
    return { success: false, message: `unsupported alg ${header.alg}` }
  }
  if (typeof header.kid !== "string") {
    return { success: false, message: "JWT header is missing kid" }
  }

  const matched = await findVerificationKey(env, header.kid)
  if (!matched) {
    return { success: false, message: "no signing key matches the JWT kid" }
  }

  const key = await importVerificationKey(matched)
  const signature = base64UrlDecodeToBytes(encodedSignature)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const ok = await crypto.subtle.verify(
    ECDSA_SIGN,
    key,
    signature,
    new TextEncoder().encode(signingInput)
  )
  if (!ok) {
    return { success: false, message: "JWT signature is invalid" }
  }

  let payload: JwtPayload
  try {
    payload = base64UrlDecodeJson<JwtPayload>(encodedPayload)
  } catch {
    return { success: false, message: "JWT payload is not valid JSON" }
  }

  return { success: true, payload, kid: matched.kid }
}
