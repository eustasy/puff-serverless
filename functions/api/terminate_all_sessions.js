import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in terminate_all_sessions. Check Pages Function configuration."
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

  // Step 2: Identify Current Session
  const authHeader = context.request.headers.get("Authorization");
  let currentSessionToken = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    currentSessionToken = authHeader.substring(7);
  }

  if (!currentSessionToken) {
    // This should ideally be caught by verifySession if it's strict about the token being present
    // for a session to be valid, but an explicit check here is good.
    console.error(
      `Current session token could not be identified for user ${user_uuid} during terminate_all_sessions, though verifySession passed.`
    );
    return new Response(
      JSON.stringify({ error: "Could not identify current session to preserve." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 3: Terminate Other Sessions
    const deleteStmt = await context.env.DATABASE.prepare(
      "DELETE FROM sessions WHERE user_uuid = ?1 AND session_id != ?2"
    )
      .bind(user_uuid, currentSessionToken)
      .run();

    // The number of changes might be 0 if the user only had one session (the current one).
    // This is still a success.
    if (deleteStmt.meta.changes_pruned_by_KI == null && deleteStmt.meta.changes == null) { // Checking for D1 specific response structure for no-ops or errors
        // This condition might indicate an issue with the D1 client or the query itself not executing as expected.
        // If .changes is null and not due to pruning, it's safer to assume an issue.
        console.warn(`D1 delete operation for other sessions for user ${user_uuid} returned unexpected metadata: ${JSON.stringify(deleteStmt.meta)}`);
        // Depending on strictness, this could be an error or logged and treated as success if no rows needed deletion.
        // For now, we'll be optimistic if no error was thrown.
    }

    // Step 4: Response
    return new Response(
      JSON.stringify({
        message: "All other active sessions terminated successfully.",
        terminated_count: deleteStmt.meta.changes || 0, // .changes is the count of rows deleted
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error terminating all other sessions:", error);
    return new Response(
      JSON.stringify({ error: "Failed to terminate other sessions due to a server error." }),
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
