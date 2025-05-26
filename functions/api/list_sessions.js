import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestGet(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in list_sessions. Check Pages Function configuration."
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

  // Step 2: Get current session token (for marking)
  let currentSessionToken = null;
  const authHeader = context.request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    currentSessionToken = authHeader.substring(7);
  }

  try {
    // Step 3: Retrieve Active Sessions
    const nowISO = new Date().toISOString();
    const { results: activeSessions } = await context.env.DATABASE.prepare(
      "SELECT session_id, created_at, expires_at, user_agent, ip_address FROM sessions WHERE user_uuid = ?1 AND expires_at > ?2 ORDER BY created_at DESC"
    )
      .bind(user_uuid, nowISO)
      .all();

    // Step 4: Data Formatting & Identify Current Session
    const formattedSessions = activeSessions.map((session) => {
      return {
        session_id: session.session_id,
        created_at: session.created_at,
        expires_at: session.expires_at,
        user_agent: session.user_agent,
        ip_address: session.ip_address,
        is_current_session: session.session_id === currentSessionToken,
      };
    });

    // Step 5: Response
    return new Response(JSON.stringify(formattedSessions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error listing active sessions:", error);
    return new Response(
      JSON.stringify({ error: "Failed to list sessions due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { Allow: "GET", "Content-Type": "application/json" },
    });
  }
  // For GET requests, Cloudflare Pages will automatically route to onRequestGet.
}
