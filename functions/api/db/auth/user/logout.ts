import { terminateSession } from "../../../../../src/sessions.js"
import { getCookie } from "../../../../../src/utilities/headers.js"
import { emitFromContext } from "../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const cookieHeader = context.request.headers.get("Cookie")
  const token = await getCookie(cookieHeader, "session_token")

  if (!token) {
    return new Response('<p class="result-negative">Session token is missing in request cookie.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  try {
    const result = await terminateSession(dbClient, user_uuid, token)

    if (result.error) {
      console.error("Error ending session:", result.error)
      return new Response(`<p class="result-negative">${result.error}</p>`, {
        status: result.status,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_LOGOUT,
      target_user_uuid: user_uuid,
    })

    const cookieOptions = [
      "session_token=;",
      "Path=/",
      "HttpOnly",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
    ]
    if (context.env.SECURE_COOKIE) {
      cookieOptions.push("Secure")
    }

    // Redirect to home page on successful logout
    return new Response(null, {
      status: 303,
      headers: {
        "Set-Cookie": cookieOptions.join("; "),
        "HX-Redirect": "/login?code=logout_success",
      },
    })
  } catch (error) {
    console.error("Error during logout process:", error)
    return new Response('<p class="result-negative">Logout failed due to a server error.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
