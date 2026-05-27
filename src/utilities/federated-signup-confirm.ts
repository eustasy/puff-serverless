export function deriveUsername(
  display_name: string | null,
  email: string | null
): string {
  if (display_name && display_name.trim() !== "") return display_name.trim()
  if (email) {
    const local = email.split("@")[0]
    if (local && local.trim() !== "") return local.trim()
  }
  return "user"
}

export function buildSessionCookie(env: Env, session_id: string): string {
  const parts = [
    `session_token=${session_id}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${env.COOKIE_SAMESITE || "Lax"}`,
    `Max-Age=${env.SESSION_MAX_AGE_SECONDS || 2592000}`,
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}
