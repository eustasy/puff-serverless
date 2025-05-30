import {
  password_check,
  password_requirements_html,
} from "../../../../src/passwords.js"
import { puff_hashing_password } from "../../../../src/utilities_hashing.js"
const { Client } = require("pg")

export async function onRequestPost(context) {

  // Step 1: Parse JSON body
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { token, new_password } = requestBody

  // Step 2: Input Validation
  if (!token || typeof token !== "string") {
    return new Response(
      JSON.stringify({ error: "Reset token is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      JSON.stringify({ error: "New password is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()
    // Step 3: Password Strength Check
    const passwordCheckResult = password_check(new_password)
    if (!passwordCheckResult.strong) {
      return new Response(password_requirements_html(), {
        status: 400,
        headers: { "Content-Type": "text/html" }, // Send as HTML
      })
    }

    // Step 4: Token Validation
    const tokenQuery = {
      text: "SELECT user_uuid, expires_at, is_used FROM tokens WHERE token_value = $1 AND token_type = \'password_reset\'",
      values: [token],
    }
    const tokenResult = await client.query(tokenQuery)
    const tokenRecord = tokenResult.rows[0]

    if (!tokenRecord) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired password reset token." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (tokenRecord.is_used === true) {
      // Assuming is_used is BOOLEAN
      return new Response(
        JSON.stringify({
          error: "Password reset token has already been used.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)
    if (now > tokenExpiresAt) {
      const updateExpiredTokenQuery = {
        text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'password_reset\'",
        values: [token],
      }
      await client.query(updateExpiredTokenQuery)
      return new Response(
        JSON.stringify({ error: "Password reset token has expired." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const user_uuid = tokenRecord.user_uuid

    // Step 5: Hash the new password
    const { hash, salt } = await puff_hashing_password(new_password)
    const secret_value = hash + ":" + salt // Store hash and salt together
    const secret_updated_at = new Date().toISOString()

    // Step 6: Update Password in secrets table
    const updatePasswordQuery = {
      text: "UPDATE secrets SET secret_value = $1, secret_created_at = $2, secret_last_used = $2 WHERE user_uuid = $3 AND secret_type = \'puff_password_sha-384\'",
      values: [secret_value, secret_updated_at, user_uuid],
    }
    const updatePasswordResult = await client.query(updatePasswordQuery)

    if (updatePasswordResult.rowCount === 0) {
      console.error(
        `Failed to update password for user_uuid: ${user_uuid}. User or secret type not found, or password already matches.`
      )
      // Check if the user exists to provide a more specific error
      const userExistsQuery = {
        text: "SELECT 1 FROM users WHERE user_uuid = $1",
        values: [user_uuid],
      }
      const userExistsResult = await client.query(userExistsQuery)
      if (userExistsResult.rowCount === 0) {
        return new Response(
          JSON.stringify({
            error: "Failed to update password. User record not found.",
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      }
      // If user exists, but secret wasn\'t updated, it might be a different issue.
      return new Response(
        JSON.stringify({
          error:
            "Failed to update password. Password record issue or no change detected.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 7: Invalidate Token
    const invalidateTokenQuery = {
      text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = \'password_reset\'",
      values: [token],
    }
    await client.query(invalidateTokenQuery)

    // Step 8: Response
    return new Response(
      JSON.stringify({ message: "Password has been reset successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during password reset:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to reset password due to a server error.",
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
