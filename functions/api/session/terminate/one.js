import {
  sessionAuthWithCookie,
  terminateSpecificSession,
} from "../../../../src/sessions.js"

export async function onRequestPost(context) {
  // Step 1: Session Verification
  const user_uuid = await sessionAuthWithCookie(context)
  if (!user_uuid || typeof user_uuid !== "string") {
    if (user_uuid instanceof Response) return user_uuid
    return new Response(
      "<p>Session invalid or expired. Please log in again.</p>",
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  // context.data.user_uuid = user_uuid; // Not strictly needed if only used here

  // Step 2: Parse JSON body for session_id_to_terminate
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(
      "<p>Error: Invalid request format. Expected JSON body.</p>",
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  const { session_id_to_terminate } = requestBody

  // Step 3: Input Validation
  if (!session_id_to_terminate || typeof session_id_to_terminate !== "string") {
    return new Response(
      "<p>Error: Session ID to terminate is missing or invalid in the request.</p>",
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  // Step 4: Terminate Specific Session using the helper function
  const terminationResult = await terminateSpecificSession(
    context,
    user_uuid,
    session_id_to_terminate
  )

  if (terminationResult.error) {
    // Specific error for session not found or not owned
    if (terminationResult.status === 404) {
      return new Response(`<p>Error: ${terminationResult.error}</p>`, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })
    }
    // Generic server error
    return new Response(`<p>Error: ${terminationResult.error}</p>`, {
      status: terminationResult.status || 500,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Step 5: Response
  if (terminationResult.rowCount > 0) {
    // For HTMX, you might want to trigger a refresh of the session list or show a success message.
    // An empty 200 OK response with an HX-Trigger header can be useful if the page should re-fetch data.
    // Or, return a partial HTML to replace the row of the terminated session.
    return new Response(
      "<p>Session terminated successfully.</p>", // Or an empty string if using HX-Trigger effectively
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          // Example: "HX-Trigger": "sessionListChanged"
        },
      }
    )
  } else {
    // This means the session was not found for this user, or was already terminated.
    // The helper function `terminateSpecificSession` now returns a 404 in this case if it wasn't found initially.
    // If it was found then deleted, rowCount would be 1. If it was found then couldn't be deleted (e.g. already gone), rowCount would be 0.
    // For simplicity, we can treat rowCount === 0 after a successful call (no error) as "it's gone".
    return new Response("<p>Session was already terminated or not found.</p>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response(
    "<p>Error: Method Not Allowed. Only POST requests are accepted.</p>",
    {
      status: 405,
      headers: { "Allow": "POST", "Content-Type": "text/html" },
    }
  )
}
