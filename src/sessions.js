import { user } from "pg/lib/defaults.js"

const { Client } = require("pg")

/**
 * Parses a cookie string and returns the value of a specific cookie.
 * @param {string | null} cookieString - The full cookie string from the request headers.
 * @param {string} cookieName - The name of the cookie to find.
 * @returns {string | null} The value of the cookie, or null if not found.
 */
export async function getCookie(cookieString, cookieName) {
  if (!cookieString) {
    return null
  }
  const cookies = cookieString.split(";")
  for (let cookie of cookies) {
    const [name, value] = cookie.trim().split("=")
    if (name === cookieName) {
      return decodeURIComponent(value)
    }
  }
  return null
}

/**
 * Verifies a session token against the database.
 *
 * @param {Client} client - An active pg Client instance.
 * @param {string} token - The session token to verify.
 * @returns {Promise<object>} An object with `user_uuid` if valid, or an `error` message and `status` if invalid/error.
 */
export async function verifyTokenAndGetUser(client, token) {
  try {
    const sessionRecordResult = await client.query(
      "SELECT user_uuid, expires_at FROM sessions WHERE session_id = $1",
      [token]
    )
    const sessionRecord = sessionRecordResult.rows[0]

    if (!sessionRecord) {
      return { error: "Invalid session token.", status: 401 }
    }

    const now = new Date()
    const expiresAt = new Date(sessionRecord.expires_at)

    if (now > expiresAt) {
      // Optionally, delete the expired session token from the database
      //await client.query("DELETE FROM sessions WHERE session_id = $1", [token])
      return { error: "Session token expired.", status: 401 }
    }

    return { user_uuid: sessionRecord.user_uuid, status: 200 } // Valid session
  } catch (error) {
    console.error("Error during token verification:", error)
    return { error: "Error during token verification.", status: 500 }
  }
}

/**
 * Middleware to handle session authentication and Hyperdrive checks.
 * It can optionally require authentication and will manage its own database client.
 *
 * @param {object} context - The Cloudflare Pages context object, containing request, env, and data.
 * @returns {Promise<Response|null>} A Response object if the request should be terminated early (e.g., due to
 *                                   missing Hyperdrive binding or failed required authentication),
 *                                   or null if the request should continue to the main handler.
 *                                   If authentication is successful, context.data.user_uuid will be set.
 */
export async function sessionAuthWithCookie(context) {
  // 1. Initialize context.data if it doesn't exist
  if (!context.data) {
    context.data = {}
  }

  // 2. Cookie parsing to get the session token
  const cookieHeader = context.request.headers.get("Cookie")
  const sessionToken = getCookie(cookieHeader, "session_token")

  // 3. Check the session token is valid
  if (sessionToken) {
    const client = new Client(context.env.HYPERDRIVE.connectionString)
    try {
      await client.connect()
      const authResult = await verifyTokenAndGetUser(client, sessionToken)
      if (authResult && authResult.user_uuid) {
        return authResult.user_uuid
      }

    } catch (dbError) {
      console.error(
        "Database connection or query error in middleware:",
        dbError
      )
      return {
        error: "An internal server error occurred during authentication.",
        status: 500,
      }
    } finally {
      if (client) {
        await client.end()
      }
    }
  } else {
    // No session token found in cookies
    return null
  }

}
