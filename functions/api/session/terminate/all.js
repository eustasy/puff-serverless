import { sessionAuthWithCookie } from "../../../src/sessions.js"
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Step 1: Session Verification
  const sessionVerificationResult = await sessionAuthWithCookie(context)
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid

  // Step 2: Identify Current Session
  const authHeader = context.request.headers.get("Authorization")
  let currentSessionToken = null
  if (authHeader && authHeader.startsWith("Bearer ")) {
    currentSessionToken = authHeader.substring(7)
  }

  if (!currentSessionToken) {
    // This should ideally be caught by sessionAuthWithCookie if it\'s strict about the token being present
    // for a session to be valid, but an explicit check here is good.
    console.error(
      `Current session token could not be identified for user ${user_uuid} during terminate_all_sessions, though sessionAuthWithCookie passed.`
    )
    return new Response(
      JSON.stringify({
        error: "Could not identify current session to preserve.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 3: Terminate Other Sessions
    const deleteQuery = {
      text: "DELETE FROM sessions WHERE user_uuid = $1 AND session_id != $2",
      values: [user_uuid, currentSessionToken],
    }
    const deleteResult = await client.query(deleteQuery)

    // Step 4: Response
    return new Response(
      JSON.stringify({
        message: "All other active sessions terminated successfully.",
        terminated_count: deleteResult.rowCount || 0,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error terminating all other sessions:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to terminate other sessions due to a server error.",
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
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  })
}
