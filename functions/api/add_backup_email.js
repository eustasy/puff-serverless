import { verifySession } from "../../src/session_auth.js" // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in add_backup_email. Check Pages Function configuration."
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

  try {
    // Step 4: Check if Email Exists for any user
    const existingEmail = await context.env.DATABASE.prepare(
      "SELECT email_id FROM emails WHERE email_address = ?1 LIMIT 1"
    )
      .bind(backup_email)
      .first()

    if (existingEmail) {
      return new Response(
        JSON.stringify({ error: "This email address is already in use." }),
        { status: 409, headers: { "Content-Type": "application/json" } } // 409 Conflict
      )
    }

    // Step 5: Store Backup Email (Unverified)
    // is_verified defaults to 0, verified_at to NULL (if schema defines it), is_primary to 0
    await context.env.DATABASE.prepare(
      "INSERT INTO emails (user_uuid, email_address, is_primary) VALUES (?1, ?2, 0)"
    )
      .bind(user_uuid, backup_email)
      .run()

    // Step 6: Generate and Store Verification Token
    const token_value = crypto.randomUUID() // Renamed from verification_token
    const token_expires_at = new Date(
      Date.now() + 24 * 60 * 60 * 1000 // 24 hours from now
    ).toISOString()

    // Using tokens table
    await context.env.DATABASE.prepare(
      "INSERT INTO tokens (user_uuid, email_address, token_type, token_value, expires_at) VALUES (?1, ?2, 'backup_email_verification', ?3, ?4)"
    )
      .bind(user_uuid, backup_email, token_value, token_expires_at)
      .run()

    // Step 7: Email Sending (Simulated)
    console.log(
      `Verification link for backup email ${backup_email}: /api/verify_backup_email?token=${token_value}` // Use token_value
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
    if (
      error.message &&
      error.message.includes(
        "UNIQUE constraint failed: emails.user_uuid, emails.email_address"
      )
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
  }
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Allow": "POST", "Content-Type": "application/json" },
    })
  }
}
