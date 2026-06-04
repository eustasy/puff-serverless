/** Redirects to target with one or more Set-Cookie headers appended (used to issue the session cookie on login). */
export function redirectWithCookies(target: string, setCookies: string[]): Response {
  const headers = new Headers({
    Location: target,
    "Cache-Control": "no-store",
  })
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie)
  }
  return new Response(null, { status: 302, headers })
}
