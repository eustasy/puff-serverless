import {
  sessionAuthWithCookie,
  terminateSpecificSession,
} from "../../../../src/sessions.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient

  // Step 1: Session Verification
  const user_uuid = await sessionAuthWithCookie(dbClient, context.request)
  if (!user_uuid || typeof user_uuid !== "string") {
    if (user_uuid instanceof Response) return user_uuid
    return new Response(
      '<p class="result-negative">Session invalid or expired. Please log in again.</p>',
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  // Step 2: Get session_id_to_terminate from URL query parameter
  const url = new URL(context.request.url)
  const session_id_to_terminate = url.searchParams.get("id")

  // Step 3: Input Validation
  if (!session_id_to_terminate || typeof session_id_to_terminate !== "string") {
    return new Response(
      '<p class="result-negative">Error: Session ID to terminate is missing or invalid in the request URL.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  // Step 4: Terminate Specific Session using the helper function
  const terminationResult = await terminateSpecificSession(
    dbClient,
    user_uuid,
    session_id_to_terminate
  )

  if (terminationResult.error) {
    // Specific error for session not found or not owned
    if (terminationResult.status === 404) {
      return new Response(
        `<p class="result-negative">Error: ${terminationResult.error}</p>`,
        {
          status: 404,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    // Generic server error
    return new Response(
      `<p class="result-negative">Error: ${terminationResult.error}</p>`,
      {
        status: terminationResult.status || 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  // Step 5: Response
  if (terminationResult.rowCount > 0) {
    return new Response(
      '<p class="result-positive">Session terminated successfully.</p>',
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "sessionListChanged",
        },
      }
    )
  } else {
    return new Response(
      '<p class="result-negative">Session was already terminated or not found.</p>',
      {
        status: 200, // Or consider 404 if appropriate for your frontend logic
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "sessionListChanged", // Also trigger refresh here to ensure UI consistency
        },
      }
    )
  }
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
