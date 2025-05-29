import { verifySession } from "../../../src/session_auth.js" // Adjust path as needed
import { authenticator } from "otplib" // Using otplib
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in remove_2fa. Check Pages Function configuration."
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

  const totp_code = requestBody.totp_code

  // Step 3: Input Validation
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      JSON.stringify({ error: "TOTP code is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 4: Check if 2FA is Enabled and retrieve secret from \'secrets\' table
    const secretQuery = {
      text: "SELECT secret_value, secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = \'totp_secret\'",
      values: [user_uuid],
    }
    const secretResult = await client.query(secretQuery)
    const secretRecord = secretResult.rows[0]

    if (!secretRecord || secretRecord.secret_enabled !== true) {
      return new Response(
        JSON.stringify({
          error: "2FA is not currently enabled for this account.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 5: Verify TOTP Code
    if (
      !secretRecord.secret_value ||
      !secretRecord.secret_value.startsWith("sim_encrypted::")
    ) {
      console.error(
        `Invalid or missing secret_value format for user ${user_uuid} of type \'totp_secret\' during 2FA removal.`
      )
      return new Response(
        JSON.stringify({ error: "Internal error with 2FA configuration." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    const storedSecret = secretRecord.secret_value.replace(
      "sim_encrypted::",
      ""
    )

    const isValid = authenticator.check(totp_code, storedSecret)

    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid TOTP code." }), {
        status: 400, // Or 401 Unauthorized
        headers: { "Content-Type": "application/json" },
      })
    }

    // Step 6: Remove 2FA Configuration (Delete the row from \'secrets\' table)
    const deleteQuery = {
      text: "DELETE FROM secrets WHERE user_uuid = $1 AND secret_type = \'totp_secret\'",
      values: [user_uuid],
    }
    const deleteResult = await client.query(deleteQuery)

    if (deleteResult.rowCount === 0) {
      console.warn(
        `Failed to delete 2FA record for user ${user_uuid}, record possibly already deleted.`
      )
    }

    // Step 7: Response
    return new Response(
      JSON.stringify({
        message: "Two-factor authentication has been removed successfully.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during 2FA removal:", error)
    return new Response(
      JSON.stringify({ error: "Failed to remove 2FA due to a server error." }),
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
