import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in user_logout. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Verify the session
  const sessionVerificationResult = await verifySession(context);

  // If verifySession returns a Response object, it means authentication failed or an error occurred.
  // Return that Response object directly.
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult;
  }

  // If verifySession returned true, the session is valid and context.data.user_uuid is populated.
  // Now, we need to get the token again to delete it.
  const authHeader = context.request.headers.get("Authorization");
  // We've already checked for authHeader and "Bearer " prefix presence in verifySession,
  // but a direct check here for the token itself is good practice.
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // This case should ideally be caught by verifySession, but as a fallback:
    return new Response(
      JSON.stringify({ error: "Authorization header is missing or malformed." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  const token = authHeader.substring(7); // Remove "Bearer " prefix

  if (!token) {
    return new Response(JSON.stringify({ error: "Session token is missing." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Step 2: Delete the session token from the database
    const deleteStmt = await context.env.DATABASE.prepare(
      "DELETE FROM sessions WHERE session_id = ?1"
    )
      .bind(token)
      .run();

    if (deleteStmt.meta.changes > 0) {
      return new Response(
        JSON.stringify({ message: "Logged out successfully." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // This might happen if the token was valid but somehow already deleted before this step,
      // or if the token was invalid but verifySession didn't catch it (unlikely).
      // For logout, we can still consider it a success from the client's perspective
      // as the session is effectively ended.
      console.warn(`No session found to delete for token (already deleted?): ${token.substring(0, 8)}...`);
      return new Response(
        JSON.stringify({ message: "Logout successful (session not found or already invalidated)." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Error during logout (session deletion):", error);
    return new Response(JSON.stringify({ error: "Logout failed due to a server error." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Fallback for other methods if needed, e.g., to return 405 Method Not Allowed
export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
  // If it's a POST request, but onRequestPost is defined,
  // Cloudflare Pages Functions will automatically route POST to onRequestPost.
  // This explicit check handles cases where onRequestPost might not be automatically called
  // or provides a clear 405 for non-POST.
  // However, with onRequestPost, this might be redundant unless other methods need explicit handling.
  // For this task, only POST is relevant.
}
