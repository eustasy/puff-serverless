import { verifySession } from "../../../src/session_auth.js"
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in change_primary_email. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

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

  const new_primary_email = requestBody.new_primary_email

  // Step 3: Input Validation
  if (
    !new_primary_email ||
    typeof new_primary_email !== "string" ||
    !new_primary_email.includes("@")
  ) {
    return new Response(
      JSON.stringify({ error: "New primary email is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()
    await client.query("BEGIN") // Start transaction

    // Step 4: Target Email Validation
    const targetEmailQuery = {
      text: "SELECT email_id, is_verified, is_primary FROM emails WHERE user_uuid = $1 AND email_address = $2 FOR UPDATE", // Lock the row
      values: [user_uuid, new_primary_email],
    }
    const targetEmailResult = await client.query(targetEmailQuery)
    const targetEmailRecord = targetEmailResult.rows[0]

    if (!targetEmailRecord) {
      await client.query("ROLLBACK")
      return new Response(
        JSON.stringify({
          error:
            "Email address not found for this account. Please add it as a backup email first.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    }

    if (targetEmailRecord.is_verified !== true) {
      await client.query("ROLLBACK")
      return new Response(
        JSON.stringify({
          error:
            "This email address must be verified before it can be made primary.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (targetEmailRecord.is_primary === true) {
      await client.query("ROLLBACK")
      return new Response(
        JSON.stringify({
          message: "This email address is already your primary email.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } } // Or 400 if considered an error
      )
    }

    // Step 5: Change Primary Email Logic (within a transaction)
    // Demote Old Primary (if any)
    const demoteQuery = {
      text: "UPDATE emails SET is_primary = FALSE WHERE user_uuid = $1 AND is_primary = TRUE",
      values: [user_uuid],
    }
    await client.query(demoteQuery) // No need to check rowCount here, as there might not be an old primary

    // Promote New Primary
    const promoteQuery = {
      text: "UPDATE emails SET is_primary = TRUE WHERE user_uuid = $1 AND email_id = $2 AND is_verified = TRUE",
      values: [user_uuid, targetEmailRecord.email_id],
    }
    const promoteResult = await client.query(promoteQuery)

    if (promoteResult.rowCount > 0) {
      await client.query("COMMIT")
      return new Response(
        JSON.stringify({ message: "Primary email changed successfully." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    } else {
      await client.query("ROLLBACK")
      console.error(
        `Failed to promote ${new_primary_email} for user ${user_uuid}. Promotion query affected 0 rows.`
      )
      return new Response(
        JSON.stringify({
          error: "Failed to change primary email due to an unexpected issue.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
  } catch (error) {
    if (client && client._connected) {
      // Check if client was connected before trying to rollback
      try {
        await client.query("ROLLBACK")
      } catch (rbError) {
        console.error("Error rolling back transaction:", rbError)
      }
    }
    console.error("Error during changing primary email:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to change primary email due to a server error.",
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
    return await onRequestPost(context) // Ensure onRequestPost is awaited
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  })
}
