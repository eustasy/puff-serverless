import { terminateAllOtherSessions } from "../../../../../../src/sessions.js"
import { getCookie } from "../../../../../../src/utilities/headers.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  // Step 2: Identify Current Session Token from Cookie
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
    dbClient,
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
    `<p>All other active sessions (count: ${terminationResult.deletedCount}) terminated successfully. This session remains active.</p>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  )
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
