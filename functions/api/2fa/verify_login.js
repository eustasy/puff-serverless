import { authenticator } from "otplib"
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Step 1: Parse JSON body for user_uuid and TOTP code
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { user_uuid, totp_code } = requestBody

  // Step 2: Input Validation
  if (!user_uuid || typeof user_uuid !== "string") {
    return new Response(
      JSON.stringify({ error: "User UUID is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
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

    // Step 3: Retrieve 2FA Secret from 'secrets' table and check if 2FA is enabled
    const secretQuery = {
      text: "SELECT secret_value, secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = 'totp_secret'",
      values: [user_uuid],
    }
    const secretResult = await client.query(secretQuery)
    const secretRecord = secretResult.rows[0]

    if (!secretRecord || !secretRecord.secret_value) {
      return new Response(
        JSON.stringify({
          error:
            "2FA setup not found for this user. Please ensure 2FA is configured.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (secretRecord.secret_enabled !== true) {
      return new Response(
        JSON.stringify({ error: "2FA is not enabled for this account." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // "Decrypt" the secret_value
    if (!secretRecord.secret_value.startsWith("sim_encrypted::")) {
      console.error(
        `Invalid secret_value format for user ${user_uuid} of type 'totp_secret'.`
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
      // Step 5: On Successful TOTP Verification, update secret_last_used and create a new session
      const now = new Date().toISOString()
      const updateSecretQuery = {
        text: "UPDATE secrets SET secret_last_used = $1 WHERE user_uuid = $2 AND secret_type = 'totp_secret'",
        values: [now, user_uuid],
      }
      await client.query(updateSecretQuery)

      const session_id = crypto.randomUUID()
      const expires_at = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days from now
      ).toISOString()
      const user_agent = context.request.headers.get("User-Agent") || ""
      const ip_address = context.request.headers.get("CF-Connecting-IP") || ""

      const insertSessionQuery = {
        text: "INSERT INTO sessions (session_id, user_uuid, expires_at, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5)",
        values: [session_id, user_uuid, expires_at, user_agent, ip_address],
      }
      await client.query(insertSessionQuery)

      return new Response(JSON.stringify({ session_token: session_id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    } else {
      // Step 6: On Failed TOTP Verification
      return new Response(JSON.stringify({ error: "Invalid TOTP code." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
  } catch (error) {
    console.error("Error during 2FA login verification:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to verify 2FA login due to a server error.",
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
