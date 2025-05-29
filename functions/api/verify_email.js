export async function onRequestGet(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    return new Response(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration.",
      { status: 500 }
    )
  }

  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  const { searchParams } = new URL(context.request.url)
  const token = searchParams.get("token")

  if (!token) {
    return new Response("Verification token is missing.", { status: 400 })
  }

  try {
    await client.connect()

    // Step 1: Query the database for the token
    // pg uses $1, $2, etc. for placeholders
    const tokenRecordResult = await client.query(
      "SELECT * FROM tokens WHERE token_value = $1 AND token_type = 'email_verification'",
      [token]
    )
    const tokenRecord = tokenRecordResult.rows[0]

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
      await client.query(
        "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = 'email_verification'",
        [token]
      )
      return new Response("Verification token expired.", { status: 400 })
    }

    // Step 3: Mark email as verified
    const user_uuid = tokenRecord.user_uuid
    const email_address = tokenRecord.email_address
    const verified_at = new Date().toISOString()

    const updateEmailResult = await client.query(
      "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3",
      [verified_at, user_uuid, email_address]
    )

    if (updateEmailResult.rowCount === 0) {
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
    await client.query(
      "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = 'email_verification'",
      [token]
    )

    return new Response("Email verified successfully. You can now log in.", {
      status: 200,
    })
  } catch (error) {
    console.error("Error during email verification:", error)
    return new Response("An internal server error occurred.", { status: 500 })
  } finally {
    await client.end()
  }
}
