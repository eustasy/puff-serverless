import { getCookie, endSession } from "../../../src/sessions.js"

export async function onRequestPost(context) {
  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  // Step 1: Get the token from the session cookie
  const cookieHeader = context.request.headers.get("Cookie")
  const token = await getCookie(cookieHeader, "session_token")

  if (!token) {
    return new Response("Session token is missing in request cookie.", {
      status: 400,
    })
  }

  // Step 2: Attempt to delete the session token
  try {
    await client.connect()
    const result = await endSession(client, token)

    if (result.error) {
      console.error("Error ending session:", result.error)
      return new Response(result.error, { status: result.status })
    }

    const cookieOptions = [
      "session_token=;",
      "Path=/",
      "HttpOnly",
      "Secure",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]

    return new Response("Logout successful. Session ended.", {
      status: 200,
      headers: {
        "Set-Cookie": cookieOptions.join("; "),
        "HX-Redirect": "/",
      },
    })
  } catch (error) {
    // This catch block might be redundant if endSession handles all its errors
    // and returns them in the result object. However, it's good for catching
    // unexpected errors like client.connect() failing.
    console.error("Error during logout process:", error)
    return new Response("Logout failed due to a server error.", { status: 500 })
  } finally {
    await client.end()
  }
}

// Fallback for other methods if needed
export async function onRequest(context) {
  // If onRequestPost is defined, Cloudflare Pages will route POST requests to it directly.
  // This function will only be called for other methods.
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
