const { Client } = require("pg")

export async function onRequestGet(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in verify_backup_email. Check Pages Function configuration."
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

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 2: Token Validation
    const tokenQuery = {
      text: "SELECT user_uuid, email_address, expires_at, is_used FROM tokens WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
      values: [token],
    }
    const tokenResult = await client.query(tokenQuery)
    const tokenRecord = tokenResult.rows[0]

    if (!tokenRecord || tokenRecord.is_used) {
      return new Response(
        JSON.stringify({
          error: "Invalid, expired, or already used verification token.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)

    if (now > tokenExpiresAt) {
      // Mark the expired token as used
      const updateExpiredTokenQuery = {
        text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
        values: [token],
      }
      await client.query(updateExpiredTokenQuery)
      return new Response(
        JSON.stringify({ error: "Verification token expired." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const user_uuid = tokenRecord.user_uuid
    const email_address = tokenRecord.email_address

    // Check if the email is already verified
    const emailDetailsQuery = {
      text: "SELECT is_verified FROM emails WHERE user_uuid = $1 AND email_address = $2",
      values: [user_uuid, email_address],
    }
    const emailDetailsResult = await client.query(emailDetailsQuery)
    const emailDetails = emailDetailsResult.rows[0]

    if (!emailDetails) {
      console.error(
        `Email ${email_address} for user ${user_uuid} not found during verification token use.`
      )
      const updateMissingEmailTokenQuery = {
        text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
        values: [token],
      }
      await client.query(updateMissingEmailTokenQuery)
      return new Response(
        JSON.stringify({
          error:
            "Associated email record not found. Please try adding the backup email again.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (emailDetails.is_verified === true) {
      const updateVerifiedEmailTokenQuery = {
        text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
        values: [token],
      }
      await client.query(updateVerifiedEmailTokenQuery)
      return new Response(
        JSON.stringify({ message: "This backup email is already verified." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 3: Mark Email as Verified
    const verified_at = new Date().toISOString()
    const updateEmailQuery = {
      text: "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3 AND is_primary = FALSE",
      values: [verified_at, user_uuid, email_address],
    }
    const updateEmailResult = await client.query(updateEmailQuery)

    if (updateEmailResult.rowCount === 0) {
      console.error(
        `Failed to update backup email verification status for token: ${token}, user_uuid: ${user_uuid}, email: ${email_address}. Email might have been promoted or deleted.`
      )
      const updateFailedUpdateTokenQuery = {
        text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
        values: [token],
      }
      await client.query(updateFailedUpdateTokenQuery)
      return new Response(
        JSON.stringify({
          error:
            "Failed to verify backup email. Please try adding it again or contact support.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 4: Invalidate Token (mark as used)
    const invalidateTokenQuery = {
      text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
      values: [token],
    }
    await client.query(invalidateTokenQuery)

    // Step 5: Response
    return new Response(
      JSON.stringify({ message: "Backup email verified successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during backup email verification:", error)
    // Attempt to invalidate token even on generic error, if token was involved.
    if (token && client && client._connected) {
      try {
        const emergencyInvalidateTokenQuery = {
          text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'backup_email_verification\'",
          values: [token],
        }
        await client.query(emergencyInvalidateTokenQuery)
        console.log(
          `Token ${token} marked as used due to an error during verification process.`
        )
      } catch (invalidationError) {
        console.error(
          `Failed to invalidate token ${token} during error handling:`,
          invalidationError
        )
      }
    }
    return new Response(
      JSON.stringify({
        error: "Failed to verify backup email due to a server error.",
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
  if (context.request.method === "GET") {
    return await onRequestGet(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "application/json" },
  })
}
