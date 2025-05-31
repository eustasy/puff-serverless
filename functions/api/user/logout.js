import { getCookie, deleteSession } from "../../../src/sessions.js"

export async function onRequestPost(context) {
  const cookieHeader = context.request.headers.get("Cookie")
  const token = await getCookie(cookieHeader, "session_token")

  if (!token) {
    return new Response(
      '<p class="error">Session token is missing in request cookie.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const result = await deleteSession(context, token)

    if (result.error) {
      console.error("Error ending session:", result.error)
      return new Response(`<p class="error">${result.error}</p>`, {
        status: result.status,
        headers: { "Content-Type": "text/html" },
      })
    }

    const cookieOptions = [
      "session_token=;",
      "Path=/",
      "HttpOnly",
      "Secure",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "SameSite=Lax", // Added SameSite for consistency
    ]

    // Redirect to home page on successful logout
    return new Response(null, {
      status: 303,
      headers: {
        "Set-Cookie": cookieOptions.join("; "),
        "HX-Redirect": "/login.html?message=Logout successful.",
      },
    })
  } catch (error) {
    console.error("Error during logout process:", error)
    return new Response(
      '<p class="error">Logout failed due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response('<p class="error">Method Not Allowed</p>', {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "text/html" },
  })
}
