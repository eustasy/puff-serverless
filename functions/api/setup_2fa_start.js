import { verifySession } from "../../src/session_auth.js" // Adjust path as needed
import { authenticator } from "otplib" // Using otplib
const { Client } = require("pg")

const APP_NAME = "YourApp" // Could be a configurable value

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in setup_2fa_start. Check Pages Function configuration."
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

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 2: Check Existing 2FA
    const existing2FAQuery = {
      text: "SELECT secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = \'totp_secret\' AND secret_enabled = TRUE",
      values: [user_uuid],
    }
    const existing2FAResult = await client.query(existing2FAQuery)

    if (existing2FAResult.rowCount > 0) {
      return new Response(
        JSON.stringify({
          error:
            "2FA is already enabled. Please remove the existing setup first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Fetch user\'s email for the label
    const emailQuery = {
      text: "SELECT email_address FROM emails WHERE user_uuid = $1 AND is_primary = TRUE LIMIT 1", // Assuming primary email is marked
      values: [user_uuid],
    }
    const emailResult = await client.query(emailQuery)

    let emailRecord
    if (emailResult.rowCount === 0) {
      console.error(`No primary email found for user_uuid: ${user_uuid}`)
      // Attempt to get any email if primary is not found, as a fallback for the label
      const anyEmailQuery = {
        text: "SELECT email_address FROM emails WHERE user_uuid = $1 ORDER BY created_at ASC LIMIT 1", // Or some other ordering
        values: [user_uuid],
      }
      const anyEmailResult = await client.query(anyEmailQuery)
      if (anyEmailResult.rowCount === 0) {
        return new Response(
          JSON.stringify({ error: "User email not found, cannot setup 2FA." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      }
      emailRecord = anyEmailResult.rows[0]
    } else {
      emailRecord = emailResult.rows[0]
    }
    const userEmail = emailRecord.email_address
    const label = `${APP_NAME}:${userEmail}`

    // Step 3: Generate TOTP Secret
    const secret = authenticator.generateSecret() // Generates a base32 secret

    // Step 4: "Simulated" Encryption
    const encrypted_secret = `sim_encrypted::${secret}`

    // Step 5: Store Secret (Temporarily/Unverified)
    // Use INSERT ... ON CONFLICT DO UPDATE to handle existing incomplete setups or create a new one.
    const now = new Date().toISOString()
    const upsertSecretQuery = {
      text: `
        INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_name, secret_enabled, secret_created_at, secret_last_used)
        VALUES ($1, \'totp_secret\', $2, $3, FALSE, $4, $4)
        ON CONFLICT (user_uuid, secret_type) 
        DO UPDATE SET 
          secret_value = EXCLUDED.secret_value,
          secret_name = EXCLUDED.secret_name,
          secret_enabled = FALSE, -- Reset to unverified if re-starting setup
          secret_created_at = EXCLUDED.secret_created_at, -- Could also choose to not update created_at
          secret_last_used = EXCLUDED.secret_last_used
      `,
      values: [user_uuid, encrypted_secret, label, now],
    }
    await client.query(upsertSecretQuery)

    // Step 6: Generate QR Code Data (TOTP Auth URI)
    const otpauthUri = authenticator.keyuri(userEmail, APP_NAME, secret)

    // Step 7: Response
    return new Response(
      JSON.stringify({
        qr_code_uri: otpauthUri,
        manual_setup_code: secret,
        message:
          "Scan the QR code or enter the manual setup code in your authenticator app, then verify.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during 2FA setup start:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to start 2FA setup due to a server error.",
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
