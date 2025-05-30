import { verifySession } from "../../../../../src/session_auth.js"
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Step 1: Session Verification
  const sessionVerificationResult = await verifySession(context)
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid

  // Step 2: Parse JSON body
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const session_id_to_terminate = requestBody.session_id

  // Step 3: Input Validation
  if (!session_id_to_terminate || typeof session_id_to_terminate !== "string") {
    return new Response(
      JSON.stringify({
        error: "Session ID to terminate is missing or invalid.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 4: Target Session Validation
    // Check if the session exists and belongs to the authenticated user.
    const targetSessionQuery = {
      text: "SELECT session_id FROM sessions WHERE session_id = $1 AND user_uuid = $2",
      values: [session_id_to_terminate, user_uuid],
    }
    const targetSessionResult = await client.query(targetSessionQuery)

    if (targetSessionResult.rowCount === 0) {
      return new Response(
        JSON.stringify({ error: "Session not found or access denied." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 5: Terminate Session
    const deleteQuery = {
      text: "DELETE FROM sessions WHERE session_id = $1 AND user_uuid = $2",
      values: [session_id_to_terminate, user_uuid],
    }
    const deleteResult = await client.query(deleteQuery)

    if (deleteResult.rowCount > 0) {
      return new Response(
        JSON.stringify({ message: "Session terminated successfully." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
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
      )
    }
  } catch (error) {
    console.error("Error terminating session:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to terminate session due to a server error.",
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
