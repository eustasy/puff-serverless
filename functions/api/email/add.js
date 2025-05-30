import { verifySession } from "../../../src/session_auth.js"
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in add_backup_email. Check Pages Function configuration."
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

  const backup_email = requestBody.backup_email

  // Step 3: Input Validation
  if (
    !backup_email ||
    typeof backup_email !== "string" ||
    !backup_email.includes("@")
  ) {
    return new Response(
      JSON.stringify({ error: "Backup email is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 4: Check if Email Exists for any user
    const existingEmailQuery = {
      text: "SELECT email_id FROM emails WHERE email_address = $1 LIMIT 1",
      values: [backup_email],
    }
    const existingEmailResult = await client.query(existingEmailQuery)

    if (existingEmailResult.rowCount > 0) {
      return new Response(
        JSON.stringify({ error: "This email address is already in use." }),
        { status: 409, headers: { "Content-Type": "application/json" } } // 409 Conflict
      )
    }

    // Step 5: Store Backup Email (Unverified)
    // is_verified defaults to FALSE, verified_at to NULL, is_primary to FALSE in PG schema
    const insertEmailQuery = {
      text: "INSERT INTO emails (user_uuid, email_address, is_primary, is_verified) VALUES ($1, $2, FALSE, FALSE)",
      values: [user_uuid, backup_email],
    }
    await client.query(insertEmailQuery)

    // Step 6: Generate and Store Verification Token
    const token_value = crypto.randomUUID()
    const token_expires_at = new Date(
      Date.now() + 24 * 60 * 60 * 1000 // 24 hours from now
    ).toISOString()

    const insertTokenQuery = {
      text: "INSERT INTO tokens (user_uuid, email_address, token_type, token_value, expires_at) VALUES ($1, $2, \'backup_email_verification\', $3, $4)",
      values: [user_uuid, backup_email, token_value, token_expires_at],
    }
    await client.query(insertTokenQuery)

    // Step 7: Email Sending (Simulated)
    console.log(
      `Verification link for backup email ${backup_email}: /api/verify_backup_email?token=${token_value}`
    )

    // Step 8: Response
    return new Response(
      JSON.stringify({
        message:
          "Backup email added. A verification link has been sent (logged) to the new email address.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during adding backup email:", error)
    // Check for unique constraint violation on emails (user_uuid, email_address) specifically
    // PostgreSQL error code for unique_violation is '23505'
    if (
      error.code === "23505" &&
      error.constraint === "emails_user_uuid_email_address_key"
    ) {
      return new Response(
        JSON.stringify({
          error: "This email address is already associated with your account.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    }
    return new Response(
      JSON.stringify({
        error: "Failed to add backup email due to a server error.",
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
