/** OIDC-compliant error response: includes a WWW-Authenticate Bearer challenge header as required by §5.3.2. */
export function bearerError(
  code: "invalid_token" | "insufficient_scope",
  description: string,
  status = 401
): Response {
  const challenge = `Bearer error="${code}", error_description="${description.replace(/"/g, "'")}"`
  return new Response(
    JSON.stringify({ error: code, error_description: description }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge,
      },
    }
  )
}
