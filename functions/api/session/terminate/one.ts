import { terminateSession } from "../../../../src/sessions.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  // Step 2: Get session_id_to_terminate from URL query parameter
  const url = new URL(context.request.url)
  const session_id_to_terminate = url.searchParams.get("id")

  // Step 3: Input Validation
  if (!session_id_to_terminate || typeof session_id_to_terminate !== "string") {
    return new Response('<p class="result-negative">Error: Session ID to terminate is missing or invalid in the request URL.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Step 4: Terminate Specific Session using the helper function
  const terminationResult = await terminateSession(dbClient, user_uuid, session_id_to_terminate)

  if (terminationResult.error) {
    // Specific error for session not found or not owned
    if (terminationResult.status === 404) {
      return new Response(`<p class="result-negative">Error: ${terminationResult.error}</p>`, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })
    }
    // Generic server error
    return new Response(`<p class="result-negative">Error: ${terminationResult.error}</p>`, {
      status: terminationResult.status || 500,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Step 5: Response
  return new Response('<p class="result-positive">Session terminated successfully.</p>', {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "HX-Trigger": "sessionListChanged",
    },
  })
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
