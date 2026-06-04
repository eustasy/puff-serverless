// "Return to" handling for the login flow.
//
// When the root middleware (functions/_middleware.ts) redirects an
// unauthenticated visitor away from a session-gated page, it stashes the page
// they wanted in the `login_next` cookie. Whichever endpoint finally grants the
// session (password login, 2FA, password upgrade, passkey) reads that cookie,
// redirects there instead of the default /account, and clears it.
//
// The cookie holds an in-app path, never a full URL: sanitizeNext rejects
// anything that is not a same-origin absolute path, so it cannot be turned into
// an open redirect.

import { getCookie } from "./headers.js"

export const NEXT_COOKIE = "login_next"

// 15 minutes — matches the mid-login flow-token TTL (createLoginToken /
// createPasswordUpgradeToken) so the destination survives a 2FA or
// password-upgrade detour, but a stale "return to" does not linger longer.
const NEXT_MAX_AGE = 900

/**
 * Returns `value` only if it is a safe in-app destination: an absolute path on
 * this origin. Rejects full and protocol-relative URLs, backslash tricks and
 * control/whitespace characters — anything that could redirect off-site or
 * smuggle a header. Otherwise returns null.
 */
export function sanitizeNext(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  // Must be an absolute path: exactly one leading slash, and the next
  // character must not start a protocol-relative ("//") or backslash form.
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") return null
  // Reject control characters and whitespace (header splitting / smuggling).
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return null
  }
  return value
}

/**
 * Reads and sanitizes the `login_next` destination from a request's cookies.
 * Returns null when absent or unsafe.
 */
export async function readNext(request: Request): Promise<string | null> {
  return sanitizeNext(await getCookie(request.headers.get("Cookie"), NEXT_COOKIE))
}

/**
 * Builds a Set-Cookie value that stores a post-login "return to" path. The
 * caller is responsible for having sanitized `value` (e.g. via a URL pathname).
 */
export function setNextCookie(env: Env, value: string): string {
  const parts = [
    `${NEXT_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${NEXT_MAX_AGE}`,
    `SameSite=${env.COOKIE_SAMESITE || "Lax"}`,
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

/** Builds a Set-Cookie value that clears the `login_next` cookie once used. */
export function clearNextCookie(env: Env): string {
  const parts = [`${NEXT_COOKIE}=`, "HttpOnly", "Path=/", "Max-Age=0", `SameSite=${env.COOKIE_SAMESITE || "Lax"}`]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}
