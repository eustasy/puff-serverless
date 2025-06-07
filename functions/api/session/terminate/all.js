import {
  sessionAuthWithCookie,
  terminateAllOtherSessions,
} from "../../../../src/sessions.js"
import { getCookie } from "../../../../src/utilities.js"

export async function onRequestPost(context) {
  // Step 1: Session Verification
  const user_uuid = await sessionAuthWithCookie(context)
  if (!user_uuid || typeof user_uuid !== "string") {
    // sessionAuthWithCookie now returns user_uuid directly or null/error object
    // If sessionAuthWithCookie returned an error object, it might be a Response already
    if (user_uuid instanceof Response) return user_uuid
    // Handle cases where user_uuid is not returned or is not a string (e.g. error object from verifyTokenAndGetUser)
    // For simplicity, returning a generic unauthorized response. Adjust as needed based on sessionAuthWithCookie's error structure.
    return new Response(
      "<p>Session invalid or expired. Please log in again.</p>",
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  context.data.user_uuid = user_uuid // Ensure user_uuid is in context.data if needed by other parts

  // Step 2: Identify Current Session Token from Cookie
  // It's more robust to get the current session token directly from the cookie
  // that sessionAuthWithCookie would have used for verification.
  const cookieHeader = context.request.headers.get("Cookie")
  const currentSessionToken = await getCookie(cookieHeader, "session_token")

  if (!currentSessionToken) {
    console.error(
      `Current session token could not be identified from cookie for user ${user_uuid} during terminate_all_sessions.`
    )
    return new Response(
      "<p>Error: Could not identify current session to preserve. Your session might be invalid.</p>",
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  // Step 3: Terminate Other Sessions using the helper function
  const terminationResult = await terminateAllOtherSessions(
    context,
    user_uuid,
    currentSessionToken
  )

  if (terminationResult.error) {
    return new Response(`<p>Error: ${terminationResult.error}</p>`, {
      status: terminationResult.status || 500,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Step 4: Response
  // Consider what HTML response is most appropriate.
  // For HTMX, you might want to return a partial that updates the UI, or a redirect.
  // For now, a simple success message.
  return new Response(
    `<p>All other active sessions (count: ${terminationResult.terminated_count}) terminated successfully. This session remains active.</p>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  )
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
