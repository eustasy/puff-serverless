const { Client } = require("pg")
const { verifySession } = require("../../../src/session_auth.js")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in remove.js. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    const formData = await context.request.formData()
    const sessionToken = formData.get("session_token")
    const emailToRemove = formData.get("email_address")

    if (!sessionToken || !emailToRemove) {
      return new Response(
        JSON.stringify({
          error: "Session token and email address are required.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    await client.connect()
    const { user_uuid, error } = await verifySession(client, sessionToken)

    if (error) {
      return new Response(JSON.stringify({ error }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Check if the email to remove is the primary email
    const emailCheckQuery = {
      text: "SELECT is_primary FROM emails WHERE user_uuid = $1 AND email_address = $2",
      values: [user_uuid, emailToRemove],
    }
    const emailCheckResult = await client.query(emailCheckQuery)

    if (emailCheckResult.rows.length === 0) {
      return new Response(
        JSON.stringify({ error: "Email address not found for this user." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    }

    if (emailCheckResult.rows[0].is_primary) {
      return new Response(
        JSON.stringify({
          error:
            "Cannot remove the primary email address. Please set another email as primary first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Proceed to delete the email if it's not primary
    const deleteEmailQuery = {
      text: "DELETE FROM emails WHERE user_uuid = $1 AND email_address = $2 AND is_primary = FALSE",
      values: [user_uuid, emailToRemove],
    }
    const deleteResult = await client.query(deleteEmailQuery)

    if (deleteResult.rowCount === 0) {
      // This could happen if the email was already deleted or conditions not met (e.g. somehow became primary between checks)
      return new Response(
        JSON.stringify({
          error:
            "Failed to remove email. It might have been already removed or an issue occurred.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ message: "Email address removed successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (err) {
    console.error("Error removing email:", err)
    return new Response(
      JSON.stringify({ error: "An internal server error occurred." }),
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
