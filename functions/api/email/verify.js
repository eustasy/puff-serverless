const { Client } = require("pg")

export async function onRequestGet(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in verify.js. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const { searchParams } = new URL(context.request.url)
  const tokenValue = searchParams.get("token")

  if (!tokenValue) {
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

    // Step 1: Query the database for the token and its type
    const tokenQuery = {
      text: "SELECT user_uuid, email_address, expires_at, is_used, token_type FROM tokens WHERE token_value = $1 AND (token_type = 'email_verification' OR token_type = 'backup_email_verification')",
      values: [tokenValue],
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

    // Step 2: Validate token expiration
    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)

    if (now > tokenExpiresAt) {
      // Mark the token as used if it's expired
      await client.query(
        "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
        [tokenValue, tokenRecord.token_type]
      )
      return new Response(
        JSON.stringify({ error: "Verification token expired." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const user_uuid = tokenRecord.user_uuid
    const email_address = tokenRecord.email_address
    const token_type = tokenRecord.token_type
    const verified_at = new Date().toISOString()

    // Step 3: Mark email as verified based on token_type
    let updateEmailResult
    if (token_type === "email_verification") {
      updateEmailResult = await client.query(
        "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3",
        [verified_at, user_uuid, email_address]
      )
    } else if (token_type === "backup_email_verification") {
      // Check if the email is already verified (as a backup)
      const emailDetailsQuery = {
        text: "SELECT is_verified FROM emails WHERE user_uuid = $1 AND email_address = $2 AND is_primary = FALSE",
        values: [user_uuid, email_address],
      }
      const emailDetailsResult = await client.query(emailDetailsQuery)
      const emailDetails = emailDetailsResult.rows[0]

      if (!emailDetails) {
        await client.query(
          "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
          [tokenValue, token_type]
        )
        return new Response(
          JSON.stringify({
            error:
              "Associated backup email record not found or is primary. Please try adding the backup email again.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      }

      if (emailDetails.is_verified === true) {
        await client.query(
          "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
          [tokenValue, token_type]
        )
        return new Response(
          JSON.stringify({ message: "This backup email is already verified." }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }

      updateEmailResult = await client.query(
        "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3 AND is_primary = FALSE",
        [verified_at, user_uuid, email_address]
      )
    } else {
      // Should not happen due to the initial query filter, but good for safety
      console.error(
        `Unknown token type: ${token_type} for token: ${tokenValue}`
      )
      return new Response(JSON.stringify({ error: "Invalid token type." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (updateEmailResult.rowCount === 0) {
      // This case might happen if the email was deleted, user_uuid/email_address didn't match,
      // or for backup email, it was promoted to primary or didn't exist as non-primary.
      console.error(
        `Failed to update email verification status for token: ${tokenValue}, user_uuid: ${user_uuid}, email: ${email_address}, type: ${token_type}`
      )
      // Mark token as used to prevent retries with a potentially problematic state
      await client.query(
        "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
        [tokenValue, token_type]
      )
      return new Response(
        JSON.stringify({
          error:
            "Failed to verify email. The email may not exist or conditions not met (e.g., backup email is primary).",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 4: Mark the token as used in the tokens table to prevent reuse
    await client.query(
      "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
      [tokenValue, token_type]
    )

    const successMessage =
      token_type === "email_verification"
        ? "Email verified successfully. You can now log in."
        : "Backup email verified successfully."

    return new Response(JSON.stringify({ message: successMessage }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Error during email verification:", error)
    // Attempt to invalidate token even on generic error, if token was involved and client is connected.
    if (
      tokenValue &&
      client &&
      client._connected &&
      tokenRecord &&
      tokenRecord.token_type
    ) {
      try {
        await client.query(
          "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2",
          [tokenValue, tokenRecord.token_type]
        )
        console.log(
          `Token ${tokenValue} (type: ${tokenRecord.token_type}) marked as used due to an error during verification process.`
        )
      } catch (invalidationError) {
        console.error(
          `Failed to invalidate token ${tokenValue} during error handling:`,
          invalidationError
        )
      }
    }
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
  if (context.request.method === "GET") {
    return await onRequestGet(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "application/json" },
  })
}
