import { verifySession } from "../../src/session_auth.js" // Adjust path as needed
import { authenticator } from "otplib" // Using otplib
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in setup_2fa_verify. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  // Step 1: Verify the session
  const sessionVerificationResult = await verifySession(context)
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult // Auth failed or error occurred
  }
  const user_uuid = context.data.user_uuid

  // Step 2: Parse JSON body for TOTP code
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

    // Step 3: Retrieve Stored Secret from \'secrets\' table
    const secretQuery = {
      text: "SELECT secret_value, secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = \'totp_secret\'",
      values: [user_uuid],
    }
    const secretResult = await client.query(secretQuery)
    const secretRecord = secretResult.rows[0]

    if (!secretRecord || !secretRecord.secret_value) {
      return new Response(
        JSON.stringify({
          error:
            "2FA setup not initiated or secret not found. Please start setup first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (secretRecord.secret_enabled === true) {
      return new Response(
        JSON.stringify({
          message: "2FA is already verified and enabled.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    // "Decrypt" the secret_value
    if (!secretRecord.secret_value.startsWith("sim_encrypted::")) {
      console.error(
        `Invalid secret_value format for user ${user_uuid} of type \'totp_secret\'.`
      )
      return new Response(
        JSON.stringify({ error: "Internal error with 2FA secret storage." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    const storedSecret = secretRecord.secret_value.replace(
      "sim_encrypted::",
      ""
    )

    // Step 4: Verify TOTP Code
    const isValid = authenticator.check(totp_code, storedSecret)

    if (isValid) {
      // Step 5: On Successful Verification, enable 2FA in \'secrets\' table
      const now = new Date().toISOString()
      const updateSecretQuery = {
        text: "UPDATE secrets SET secret_enabled = TRUE, secret_last_used = $1 WHERE user_uuid = $2 AND secret_type = \'totp_secret\'",
        values: [now, user_uuid],
      }
      await client.query(updateSecretQuery)

      return new Response(
        JSON.stringify({ message: "2FA setup successful and enabled." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    } else {
      // Step 6: On Failed Verification
      return new Response(
        JSON.stringify({ error: "Invalid TOTP code. Please try again." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
  } catch (error) {
    console.error("Error during 2FA verification:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to verify 2FA setup due to a server error.",
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
