// Cookie that carries the OAuth-client state + PKCE verifier between
// /login/[provider] (the redirect away from Puff) and
// /login/[provider]/callback (the provider's redirect back).
//
// We do not sign the cookie: the user is free to forge any value they like,
// but the protection is the equality check between the cookie's `state` and
// the `state` returned in the provider's callback query string. Both are
// generated server-side and only ever match for the request we issued.
//
// SameSite=Lax is mandatory: the cookie has to survive the provider's
// top-level GET redirect back to Puff. Strict would drop it.

const COOKIE_NAME = "oauth_state"

// 10 minutes — long enough for the user to complete a consent screen at the
// provider; short enough that an abandoned attempt expires quickly.
const STATE_MAX_AGE = 600

export interface OAuthStateCookie {
  /** The provider this state was issued for — guards against cross-provider replay. */
  provider: string
  /** Random opaque state, echoed back by the provider in the callback. */
  state: string
  /** PKCE code verifier — base64url, 43-128 chars. */
  code_verifier: string
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(input: string): string | null {
  try {
    const padded =
      input.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((input.length + 3) % 4)
    return atob(padded)
  } catch {
    return null
  }
}

/**
 * Builds the Set-Cookie header value carrying the OAuth client state. Body
 * is base64url-encoded JSON so cookie characters are safe and the format is
 * trivially parseable.
 */
export function setOAuthStateCookie(env: Env, value: OAuthStateCookie): string {
  const encoded = base64UrlEncode(JSON.stringify(value))
  const parts = [
    `${COOKIE_NAME}=${encoded}`,
    "HttpOnly",
    "Path=/login",
    `Max-Age=${STATE_MAX_AGE}`,
    // Lax: must survive the provider's cross-site GET redirect back.
    "SameSite=Lax",
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

/** Reads + parses the OAuth state cookie, or null if absent/malformed. */
export async function readOAuthStateCookie(
  cookieHeader: string | null
): Promise<OAuthStateCookie | null> {
  if (!cookieHeader) return null
  // Reuse the existing cookie helper to extract the named cookie value.
  const { getCookie } = await import("./headers.js")
  const raw = await getCookie(cookieHeader, COOKIE_NAME)
  if (!raw) return null
  const json = base64UrlDecode(raw)
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<OAuthStateCookie>
    if (
      typeof parsed.provider === "string" &&
      typeof parsed.state === "string" &&
      typeof parsed.code_verifier === "string"
    ) {
      return parsed as OAuthStateCookie
    }
  } catch {
    /* fall through */
  }
  return null
}

/** Cleared Set-Cookie value for after a successful or failed callback. */
export function clearOAuthStateCookie(env: Env): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/login",
    "Max-Age=0",
    "SameSite=Lax",
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

// --- PKCE helpers ---------------------------------------------------------

function randomBase64Url(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!)
  return base64UrlEncode(binary)
}

/** Generates a fresh state nonce (32 bytes of base64url-encoded entropy). */
export function generateState(): string {
  return randomBase64Url(32)
}

/**
 * Generates a PKCE verifier + challenge pair. The verifier is 64 bytes of
 * base64url; the S256 challenge is `base64url(SHA-256(verifier))`.
 */
export async function generatePkcePair(): Promise<{
  verifier: string
  challenge: string
}> {
  const verifier = randomBase64Url(64)
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  )
  const bytes = new Uint8Array(hash)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const challenge = base64UrlEncode(binary)
  return { verifier, challenge }
}
