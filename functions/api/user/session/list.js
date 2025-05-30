import { sessionAuthWithCookie } from "../../../../src/sessions.js"
const { Client } = require("pg")

export async function onRequestGet(context) {
  // Step 1: Session Verification
  const sessionVerificationResult = await sessionAuthWithCookie(context)
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid

  // Step 2: Get current session token (for marking)
  let currentSessionToken = null
  const authHeader = context.request.headers.get("Authorization")
  if (authHeader && authHeader.startsWith("Bearer ")) {
    currentSessionToken = authHeader.substring(7)
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 3: Retrieve Active Sessions
    const nowISO = new Date().toISOString()
    const sessionsQuery = {
      text: "SELECT session_id, created_at, expires_at, user_agent, ip_address FROM sessions WHERE user_uuid = $1 AND expires_at > $2 ORDER BY created_at DESC",
      values: [user_uuid, nowISO],
    }
    const sessionsResult = await client.query(sessionsQuery)
    const activeSessions = sessionsResult.rows

    // Step 4: Data Formatting & Identify Current Session
    const formattedSessions = activeSessions.map((session) => {
      return {
        session_id: session.session_id,
        created_at: session.created_at,
        expires_at: session.expires_at,
        user_agent: session.user_agent,
        ip_address: session.ip_address,
        is_current_session: session.session_id === currentSessionToken,
      }
    })

    // Step 5: Response
    return new Response(JSON.stringify(formattedSessions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Error listing active sessions:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to list sessions due to a server error.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  } finally {
    if (client) {
      await client.end()
    }
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") {
    return await onRequestGet(context) // Ensure onRequestGet is awaited
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "application/json" },
  })
}
