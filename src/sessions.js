import { randomBytes } from "node:crypto"

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

/**
 * Starts a new session by inserting it into the database.
 * The session ID is generated internally and expires in 24 hours.
 *
 * @param {Client} client - An active pg Client instance.
 * @param {string} user_uuid - The UUID of the user starting the session.
 * @param {string} [user_agent] - (Optional) The user agent string from the request.
 * @param {string} [ip_address] - (Optional) The IP address from the request.
 * @returns {Promise<object>} An object with the session_id if successful, or an `error` message and `status` if failed.
 */
export async function createSession(client, user_uuid, user_agent, ip_address) {
  if (!user_uuid) {
    return { error: "User UUID is required.", status: 400 }
  }
  try {
    const session_id = randomBytes(32).toString("hex")
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000) // Session expires in 24 hours

    // Base query and parameters
    let query = "INSERT INTO sessions (user_uuid, session_id, expires_at"
    let params = [user_uuid, session_id, expires_at]
    let valuePlaceholders = "$1, $2, $3"

    // Add user_agent if provided
    if (user_agent) {
      query += ", user_agent"
      params.push(user_agent)
      valuePlaceholders += `, $${params.length}`
    }

    // Add ip_address if provided
    if (ip_address) {
      query += ", ip_address"
      params.push(ip_address)
      valuePlaceholders += `, $${params.length}`
    }

    query += `) VALUES (${valuePlaceholders})`

    await client.query(query, params)
    return {
      session_id: session_id,
      status: 200,
      expires_at: expires_at,
    }
  } catch (error) {
    console.error("Error during session creation:", error)
    return {
      error: "Failed to start session due to a server error.",
      status: 500,
    }
  }
}

/**
 * Ends a session by deleting it from the database.
 *
 * @param {object} context - The Cloudflare Pages context object, containing request, env, and data.
 * @param {string} token - The session token to delete.
 * @returns {Promise<object>} An object with `rowCount` if successful, or an `error` message and `status` if failed.
 */
export async function deleteSession(context, token) {
  if (!token) {
    return { error: "Session token is required.", status: 400 }
  }
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const deleteResult = await client.query(
      "DELETE FROM sessions WHERE session_id = $1",
      [token]
    )
    return { rowCount: deleteResult.rowCount, status: 200 }
  } catch (error) {
    console.error("Error during session deletion:", error)
    return {
      error: "Failed to end session due to a server error.",
      status: 500,
    }
  } finally {
    if (client) {
      await client.end()
    }
  }
}
