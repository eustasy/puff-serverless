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

/**
 * Retrieves all active sessions for a given user.
 *
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user whose sessions are to be retrieved.
 * @returns {Promise<object>} An object with an array of `sessions` if successful, or an `error` message and `status` if failed.
 */
export async function listActiveSessionsForUser(context, user_uuid) {
  if (!user_uuid) {
    return { error: "User UUID is required.", status: 400 }
  }
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const nowISO = new Date().toISOString()
    const sessionsQuery = {
      text: "SELECT session_id, created_at, expires_at, user_agent, ip_address FROM sessions WHERE user_uuid = $1 AND expires_at > $2 ORDER BY created_at DESC",
      values: [user_uuid, nowISO],
    }
    const sessionsResult = await client.query(sessionsQuery)
    return { sessions: sessionsResult.rows, status: 200 }
  } catch (error) {
    console.error("Error listing active sessions:", error)
    return {
      error: "Failed to list sessions due to a server error.",
      status: 500,
    }
  } finally {
    if (client) {
      await client.end()
    }
  }
}

/**
 * Terminates all active sessions for a given user, except for the specified current session.
 *
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user whose other sessions are to be terminated.
 * @param {string} currentSessionTokenToPreserve - The session ID of the current session, which should not be terminated.
 * @returns {Promise<object>} An object with `terminated_count` if successful, or an `error` message and `status` if failed.
 */
export async function terminateAllOtherSessions(
  context,
  user_uuid,
  currentSessionTokenToPreserve
) {
  if (!user_uuid) {
    return { error: "User UUID is required.", status: 400 }
  }
  if (!currentSessionTokenToPreserve) {
    return {
      error: "Current session token to preserve is required.",
      status: 400,
    }
  }

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const deleteQuery = {
      text: "DELETE FROM sessions WHERE user_uuid = $1 AND session_id != $2",
      values: [user_uuid, currentSessionTokenToPreserve],
    }
    const deleteResult = await client.query(deleteQuery)
    return { terminated_count: deleteResult.rowCount || 0, status: 200 }
  } catch (error) {
    console.error("Error terminating all other sessions:", error)
    return {
      error: "Failed to terminate other sessions due to a server error.",
      status: 500,
    }
  } finally {
    if (client) {
      await client.end()
    }
  }
}

/**
 * Terminates a specific session for a given user, ensuring the session belongs to that user.
 *
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user who owns the session.
 * @param {string} session_id_to_terminate - The ID of the session to terminate.
 * @returns {Promise<object>} An object with `rowCount` (should be 1 if successful, 0 if not found/not owned)
 *                            or an `error` message and `status` if failed.
 */
export async function terminateSpecificSession(
  context,
  user_uuid,
  session_id_to_terminate
) {
  if (!user_uuid) {
    return { error: "User UUID is required.", status: 400 }
  }
  if (!session_id_to_terminate) {
    return { error: "Session ID to terminate is required.", status: 400 }
  }

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()

    // First, verify the session belongs to the user to prevent unauthorized deletions
    // Although the DELETE query also has this check, this provides a clearer error if it doesn't exist or belong.
    const verifyQuery = {
      text: "SELECT session_id FROM sessions WHERE session_id = $1 AND user_uuid = $2",
      values: [session_id_to_terminate, user_uuid],
    }
    const verifyResult = await client.query(verifyQuery)

    if (verifyResult.rowCount === 0) {
      return {
        error:
          "Session not found or you do not have permission to terminate it.",
        status: 404,
      }
    }

    // If verification passes, proceed to delete
    const deleteQuery = {
      text: "DELETE FROM sessions WHERE session_id = $1 AND user_uuid = $2",
      values: [session_id_to_terminate, user_uuid],
    }
    const deleteResult = await client.query(deleteQuery)
    return { rowCount: deleteResult.rowCount, status: 200 } // rowCount will be 1 if deleted, 0 if already gone
  } catch (error) {
    console.error("Error terminating specific session:", error)
    return {
      error: "Failed to terminate session due to a server error.",
      status: 500,
    }
  } finally {
    if (client) {
      await client.end()
    }
  }
}
