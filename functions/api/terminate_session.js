import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in terminate_session. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Session Verification
  const sessionVerificationResult = await verifySession(context);
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult; // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid;

  // Step 2: Parse JSON body
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session_id_to_terminate = requestBody.session_id;

  // Step 3: Input Validation
  if (!session_id_to_terminate || typeof session_id_to_terminate !== "string") {
    return new Response(
      JSON.stringify({ error: "Session ID to terminate is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 4: Target Session Validation
    // Check if the session exists and belongs to the authenticated user.
    // No need to check if it's expired, as we're just deleting it.
    const targetSession = await context.env.DATABASE.prepare(
      "SELECT session_id FROM sessions WHERE session_id = ?1 AND user_uuid = ?2"
    )
      .bind(session_id_to_terminate, user_uuid)
      .first();

    if (!targetSession) {
      return new Response(
        JSON.stringify({ error: "Session not found or access denied." }),
        { status: 404, headers: { "Content-Type": "application/json" } } // 404 implies not found, 403 if we confirm it exists but different user
      );
    }

    // Step 5: Terminate Session
    const deleteStmt = await context.env.DATABASE.prepare(
      "DELETE FROM sessions WHERE session_id = ?1 AND user_uuid = ?2"
    )
      .bind(session_id_to_terminate, user_uuid)
      .run();

    if (deleteStmt.meta.changes > 0) {
      return new Response(
        JSON.stringify({ message: "Session terminated successfully." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // This case means the session existed (from the check above) but was not deleted.
      // This could happen if it was deleted by another request between the check and this delete.
      // Or if it expired and a cleanup process removed it.
      // For the client, the session is gone, so it's effectively a success.
      return new Response(
        JSON.stringify({
          message: "Session already terminated or not found for deletion.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Error terminating session:", error);
    return new Response(
      JSON.stringify({ error: "Failed to terminate session due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
}
