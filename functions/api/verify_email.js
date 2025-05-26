export async function onRequestGet(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    return new Response(
      "D1 Database binding [DATABASE] not found. Please check Pages Function configuration.",
      { status: 500 }
    )
  }

  const { searchParams } = new URL(context.request.url)
  const token = searchParams.get("token")

  if (!token) {
    return new Response("Verification token is missing.", { status: 400 })
  }

  try {
    // Step 1: Query the database for the token
    const tokenRecord = await context.env.DATABASE.prepare(
      "SELECT * FROM tokens WHERE token_value = ?1 AND token_type = 'email_verification'"
    )
      .bind(token)
      .first()

    if (!tokenRecord || tokenRecord.is_used) {
      // Also check if token is already used
      return new Response("Invalid, expired, or already used token.", {
        status: 400,
      })
    }

    // Step 2: Validate token expiration
    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)

    if (now > tokenExpiresAt) {
      // Mark the token as used if it's expired
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'email_verification'"
      )
        .bind(token)
        .run()
      return new Response("Verification token expired.", { status: 400 })
    }

    // Step 3: Mark email as verified
    const user_uuid = tokenRecord.user_uuid
    const email_address = tokenRecord.email_address
    const verified_at = new Date().toISOString()

    const updateEmailStmt = await context.env.DATABASE.prepare(
      "UPDATE emails SET is_verified = 1, verified_at = ?1 WHERE user_uuid = ?2 AND email_address = ?3"
    )
      .bind(verified_at, user_uuid, email_address)
      .run()

    if (updateEmailStmt.meta.changes === 0) {
      // This case might happen if the email was deleted or user_uuid/email_address didn't match
      console.error(
        `Failed to update email verification status for token: ${token}, user_uuid: ${user_uuid}, email: ${email_address}`
      )
      return new Response(
        "Failed to verify email. Please try registering again or contact support.",
        { status: 500 }
      )
    }

    // Step 4: Mark the token as used in the tokens table to prevent reuse
    await context.env.DATABASE.prepare(
      "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'email_verification'"
    )
      .bind(token)
      .run()

    return new Response("Email verified successfully. You can now log in.", {
      status: 200,
    })
  } catch (error) {
    console.error("Error during email verification:", error)
    return new Response("An internal server error occurred.", { status: 500 })
  }
}
