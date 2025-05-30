import { user_login } from "../../../src/users.js"
import { startSession } from "../../../src/sessions.js"

export async function onRequestPost(context) {
  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const pw = formdata.get("pw")
  if (!email || !pw) {
    return new Response("Email and password are required.", { status: 400 })
  }

  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()
    const loginResult = await user_login(client, email, pw) // Pass client to user_login

    if (loginResult.error) {
      return new Response(loginResult.error, { status: loginResult.status })
    }

    // TODO handle TOTP if required
    // Assuming user_login returns an object with user_uuid on successful login
    // If TOTP is required, user_login should return a specific response indicating that
    // For example, it could return { totp_required: true, user_uuid: user_uuid }

    // If login is successful, loginResult.user_uuid should be available
    const user_uuid = loginResult.user_uuid

    // Get User Agent and IP Address from the request context
    const user_agent = context.request.headers.get("User-Agent")
    const ip_address = context.request.headers.get("CF-Connecting-IP") // Cloudflare specific header for client IP

    // Start a session for the user
    const sessionResult = await startSession(
      client,
      user_uuid,
      user_agent,
      ip_address
    )

    // Check if session creation was successful
    if (sessionResult.error) {
      return new Response(sessionResult.error, { status: sessionResult.status })
    }

    // Set the session token in a cookie
    const cookieOptions = [
      `session_token=${sessionResult.session_id};`,
      "Path=/",
      "HttpOnly",
      "Secure",
      `Expires=${sessionResult.expires_at.toUTCString()}`,
      // "SameSite=Lax" // Or "Strict" or "None" (if Secure is also set and cross-site usage is intended)
    ]

    return new Response("Login successful. Session started.", {
      status: 200,
      headers: {
        "Set-Cookie": cookieOptions.join("; "),
        "HX-Redirect": "/",
      },
    })
  } catch (error) {
    console.error("Error in user_login endpoint:", error)
    return new Response("An unexpected error occurred during login.", {
      status: 500,
    })
  } finally {
    await client.end()
  }
}

// Fallback for other methods if needed
export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" }, // Only POST is allowed for login
  })
}
