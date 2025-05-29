export async function verifySession(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in verifySession. Check Pages Function configuration."
    )
    return new Response("Internal server configuration error.", { status: 500 })
  }
  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  const authHeader = context.request.headers.get("Authorization")
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Authorization header is missing or malformed.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="example"' },
    })
  }

  const token = authHeader.substring(7) // Remove "Bearer " prefix

  if (!token) {
    return new Response("Session token is missing.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="example"' },
    })
  }

  try {
    await client.connect()
    const sessionRecordResult = await client.query(
      "SELECT user_uuid, expires_at FROM sessions WHERE session_id = $1",
      [token]
    )
    const sessionRecord = sessionRecordResult.rows[0]

    if (!sessionRecord) {
      return new Response("Invalid session token.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      })
    }

    const now = new Date()
    const expiresAt = new Date(sessionRecord.expires_at)

    if (now > expiresAt) {
      // Optionally, delete the expired session token from the database
      await client.query("DELETE FROM sessions WHERE session_id = $1", [token])
      return new Response("Session token expired.", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer error="invalid_token", error_description="The session token has expired"',
        },
      })
    }

    // Add user_uuid to context.data for downstream Functions
    // Ensure context.data is initialized if it's not already
    if (!context.data) {
      context.data = {}
    }
    context.data.user_uuid = sessionRecord.user_uuid

    return true // Indicates a valid session
  } catch (error) {
    console.error("Error during session verification:", error)
    return new Response(
      "An internal server error occurred during session verification.",
      {
        status: 500,
      }
    )
  } finally {
    await client.end()
  }
}
