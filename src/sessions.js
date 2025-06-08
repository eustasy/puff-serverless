import { randomBytes } from "node:crypto"
import { loginUser } from "./users"

/**
 * Verifies a session token against the database.
 *
 * @param {Client} dbClient - An active pg.Client instance (expected to be connected).
 * @param {string} token - The session token to verify.
 * @returns {Promise<object>} An object with `user_uuid` if valid, or an `error` message and `status` if invalid/error.
 */
export async function verifyTokenAndGetUser(dbClient, token) {
  try {
    const sessionRecordResult = await dbClient.query(
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
      //await dbClient.query("DELETE FROM sessions WHERE session_id = $1", [token])
      return { error: "Session token expired.", status: 401 }
    }

    return { user_uuid: sessionRecord.user_uuid, status: 200 } // Valid session
  } catch (error) {
    console.error("Error during token verification:", error)
    return { error: "Error during token verification.", status: 500 }
  }
}

/**
 * Starts a new session by inserting it into the database.
 * The session ID is generated internally and expires in 24 hours.
 *
 * @param {Client} dbClient - An active pg.Client instance (expected to be connected).
 * @param {string} user_uuid - The UUID of the user starting the session.
 * @param {string} [user_agent] - (Optional) The user agent string from the request.
 * @param {string} [ip_address] - (Optional) The IP address from the request.
 * @returns {Promise<object>} An object with the session_id if successful, or an `error` message and `status` if failed.
 */
export async function createSession(
  dbClient,
  user_uuid,
  user_agent,
  ip_address
) {
  if (!user_uuid) {
    return { error: "User UUID is required.", status: 400 }
  }
  try {
    const session_id = randomBytes(32).toString("hex")
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

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

    await dbClient.query(query, params)
    await loginUser(dbClient, user_uuid)
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
 * Terminates a specific session from the database by marking it as not active.
 *
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user who owns the session.
 * @param {string} session_id - The ID of the session to terminate.
 * @returns {Promise<{success?: boolean, error?: string, status?: number}>} Result of the operation.
 */
export async function terminateSpecificSession(dbClient, user_uuid, session_id) {
  try {
    const result = await dbClient.query(
      "UPDATE sessions SET is_active = FALSE WHERE session_id = $1 AND user_uuid = $2 AND is_active = TRUE RETURNING session_id",
      [session_id, user_uuid]
    )
    if (result.rowCount > 0) {
      return { success: true, status: 200 }
    } else {
      return { error: "Session not found or already terminated.", status: 404 }
    }
  } catch (error) {
    console.error("Error in terminateSpecificSession:", error)
    return {
      error: "Failed to terminate session due to a server error.",
      status: 500,
    }
  }
}

/**
 * Terminates all sessions for a given user from the database by marking them as not active,
 * except for the specified session ID.
 *
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user whose sessions are to be deleted.
 * @param {string} session_id - The ID of the session to exclude from deletion (optional).
 * @returns {Promise<{deletedCount?: number, error?: string, status?: number}>} Result of the operation.
 */
export async function terminateAllOtherSessions(
  dbClient,
  user_uuid,
  session_id
) {
  try {
    const result = await dbClient.query(
      "UPDATE sessions SET is_active = FALSE WHERE user_uuid = $1 AND session_id != $2 AND is_active = TRUE RETURNING session_id",
      [user_uuid, session_id]
    )
    return { deletedCount: result.rowCount, status: 200 }
  } catch (error) {
    console.error("Error in terminateAllOtherSessions:", error)
    return {
      error: "Failed to terminate sessions due to a server error.",
      status: 500,
    }
  }
}

/**
 * Lists all active sessions for a given user.
 *
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<{sessions?: Array<object>, error?: string, status?: number}>} List of sessions or error.
 */
export async function listSessionsForUser(dbClient, user_uuid) {
  try {
    const result = await dbClient.query(
      "SELECT session_id, created_at, expires_at, user_agent, ip_address FROM sessions WHERE user_uuid = $1 ORDER BY created_at DESC",
      [user_uuid]
    )
    return { sessions: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in listSessionsForUser:", error)
    return {
      error: "Failed to list sessions due to a server error.",
      status: 500,
    }
  }
}
