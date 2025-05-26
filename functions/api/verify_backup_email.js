export async function onRequestGet(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in verify_backup_email. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  // Step 1: Extract token from query parameters
  const { searchParams } = new URL(context.request.url)
  const token = searchParams.get("token")

  if (!token) {
    return new Response(
      JSON.stringify({ error: "Verification token is missing." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    // Step 2: Token Validation
    const tokenRecord = await context.env.DATABASE.prepare(
      "SELECT user_uuid, email_address, expires_at, is_used FROM tokens WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
    )
      .bind(token)
      .first()

    if (!tokenRecord || tokenRecord.is_used) {
      // Check if token exists and is not already used
      return new Response(
        JSON.stringify({
          error: "Invalid, expired, or already used verification token.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at) // Use expires_at

    if (now > tokenExpiresAt) {
      // Mark the expired token as used
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
      )
        .bind(token)
        .run()
      return new Response(
        JSON.stringify({ error: "Verification token expired." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const user_uuid = tokenRecord.user_uuid
    const email_address = tokenRecord.email_address

    // Check if the email is already verified (for this user, as token is user-specific)
    const emailDetails = await context.env.DATABASE.prepare(
      "SELECT is_verified FROM emails WHERE user_uuid = ?1 AND email_address = ?2"
    )
      .bind(user_uuid, email_address)
      .first()

    if (!emailDetails) {
      // This implies the email added via add_backup_email was somehow removed before verification
      console.error(
        `Email ${email_address} for user ${user_uuid} not found during verification token use.`
      )
      // Mark token as used to prevent re-querying
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
      )
        .bind(token)
        .run()
      return new Response(
        JSON.stringify({
          error:
            "Associated email record not found. Please try adding the backup email again.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (emailDetails.is_verified === 1) {
      // Token is valid but email already verified. Mark token as used.
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
      )
        .bind(token)
        .run()
      return new Response(
        JSON.stringify({ message: "This backup email is already verified." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 3: Mark Email as Verified
    const verified_at = new Date().toISOString()
    const updateEmailStmt = await context.env.DATABASE.prepare(
      "UPDATE emails SET is_verified = 1, verified_at = ?1 WHERE user_uuid = ?2 AND email_address = ?3 AND is_primary = 0"
    ) // Ensure we only verify backup emails here. is_primary = 0 is an explicit check for backup.
      .bind(verified_at, user_uuid, email_address)
      .run()

    if (updateEmailStmt.meta.changes === 0) {
      // This might happen if the email was somehow marked as primary or deleted between checks.
      console.error(
        `Failed to update backup email verification status for token: ${token}, user_uuid: ${user_uuid}, email: ${email_address}. Email might have been promoted or deleted.`
      )
      // Mark token as used to prevent re-querying
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
      )
        .bind(token)
        .run()
      return new Response(
        JSON.stringify({
          error:
            "Failed to verify backup email. Please try adding it again or contact support.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 4: Invalidate Token (mark as used)
    await context.env.DATABASE.prepare(
      "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'backup_email_verification'"
    )
      .bind(token)
      .run()

    // Step 5: Response
    return new Response(
      JSON.stringify({ message: "Backup email verified successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during backup email verification:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to verify backup email due to a server error.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Allow": "GET", "Content-Type": "application/json" },
    })
  }
  // For GET requests, Cloudflare Pages will automatically route to onRequestGet.
}
