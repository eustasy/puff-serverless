import { randomBytes } from "node:crypto"
import { Client } from "pg"
import { updateLastLogin } from "./users"

/**
 * Verifies a session token against the database.
 *
 * @param {Client} dbClient - An active pg.Client instance (expected to be connected).
 * @param {string} token - The session token to verify.
 * @param {string} [ip_country] - The country code from the current request's CF-IPCountry header.
 * @param {string} [ip_address] - The IP address from CF-Connecting-IP, written to last_accessed_ip on successful auth.
 * @returns {Promise<object>} An object with `user_uuid` if valid, or an `error` message and `status` if invalid/error.
 */
export async function verifyTokenAndGetUser(
  dbClient: DbClient,
  token: string,
  ip_country: string | null,
  ip_address: string | null
): Promise<{ success: true; error?: never; user_uuid: string; status: 200 } | { success?: never; error: string; status: number }> {
  try {
    const sessionRecordResult = await dbClient.query(
      "SELECT user_uuid, expires_at, ip_country FROM sessions WHERE session_id = $1 AND is_active = TRUE",
      [token]
    )
    const sessionRecord = sessionRecordResult.rows[0]

    if (!sessionRecord) {
      return { error: "Invalid session token.", status: 401 }
    }

    const now = new Date()
    const expiresAt = new Date(sessionRecord.expires_at)

    if (now > expiresAt) {
      return { error: "Session token expired.", status: 401 }
    }

    if (ip_country && sessionRecord.ip_country && ip_country !== sessionRecord.ip_country) {
      return {
        error: "Session invalidated due to location change. Please log in again.",
        status: 401,
      }
    }

    // Fire-and-forget last-access bookkeeping. Auth has already succeeded;
    // a failure to record the access shouldn't fail the request.
    dbClient
      .query("UPDATE sessions SET last_accessed_at = CURRENT_TIMESTAMP, last_accessed_ip = $1 WHERE session_id = $2", [
        ip_address || null,
        token,
      ])
      .catch((err: unknown) => console.error("Error updating session last-accessed fields:", err))

    return { success: true, user_uuid: sessionRecord.user_uuid, status: 200 }
  } catch (error) {
    console.error("Error during token verification:", error)
    return { error: "Error during token verification.", status: 500 }
  }
}

/**
 * Verifies a session token by opening its own short-lived database connection.
 * For callers that run outside the functions/api/_middleware.ts policy chain and
 * so have no injected dbClient — e.g. the root functions/_middleware.ts deciding
 * whether to redirect an already-logged-in user away from /login.
 *
 * Returns a plain boolean. Fails open: a connection or query error is logged
 * and returns false, so a database problem never blocks page delivery.
 *
 * @param {Env} env - Worker environment, for the Hyperdrive connection string.
 * @param {string} token - The session token to verify.
 * @param {string | null} ip_country - The CF-IPCountry header value.
 * @param {string | null} ip_address - The CF-Connecting-IP header value.
 * @returns {Promise<boolean>} true only if the session is currently valid.
 */
export async function verifySessionToken(env: Env, token: string, ip_country: string | null, ip_address: string | null): Promise<boolean> {
  if (!env.HYPERDRIVE || !env.HYPERDRIVE.connectionString) return false
  const client = new Client(env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const result = await verifyTokenAndGetUser(client, token, ip_country, ip_address)
    return result.success === true
  } catch (error) {
    console.error("verifySessionToken: session check failed:", error)
    return false
  } finally {
    try {
      await client.end()
    } catch {}
  }
}

/**
 * Starts a new session by inserting it into the database.
 * The session ID is generated internally and expires in 7 days.
 *
 * @param {Client} dbClient - An active pg.Client instance (expected to be connected).
 * @param {string} user_uuid - The UUID of the user starting the session.
 * @param {string} [user_agent] - The user agent string from the request.
 * @param {string} [ip_address] - The IP address from the request.
 * @param {string} [ip_country] - The country code from CF-IPCountry header.
 * @returns {Promise<object>} An object with the session_id if successful, or an `error` message and `status` if failed.
 */
export async function createSession(
  dbClient: DbClient,
  user_uuid: string,
  user_agent: string,
  ip_address: string,
  ip_country: string
): Promise<
  | {
      success: true
      error?: never
      session_id: string
      status: 200
      expires_at: Date
    }
  | { success?: never; error: string; status: number }
> {
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

    // Add ip_country if provided
    if (ip_country) {
      query += ", ip_country"
      params.push(ip_country)
      valuePlaceholders += `, $${params.length}`
    }

    query += `) VALUES (${valuePlaceholders})`

    await dbClient.query(query, params)
    const loginResult = await updateLastLogin(dbClient, user_uuid)
    if (loginResult.error) {
      // Preserve prior behavior of failing session creation on a DB error here.
      throw new Error(loginResult.message)
    }
    return {
      success: true,
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
export async function terminateSession(
  dbClient: DbClient,
  user_uuid: string,
  session_id: string
): Promise<{ error?: never; success: true; status: 200 } | { success?: never; error: string; status: number }> {
  try {
    const result = await dbClient.query(
      "UPDATE sessions SET is_active = FALSE WHERE session_id = $1 AND user_uuid = $2 AND is_active = TRUE RETURNING session_id",
      [session_id, user_uuid]
    )
    if ((result.rowCount ?? 0) > 0) {
      return { success: true, status: 200 }
    } else {
      console.error(`Session termination failed: session not found or not owned by user ${user_uuid}.`)
      return { error: "Session not found or already terminated.", status: 404 }
    }
  } catch (error) {
    console.error("Error in terminateSession:", error)
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
  dbClient: DbClient,
  user_uuid: string,
  session_id: string
): Promise<{ success: true; error?: never; deletedCount: number; status: 200 } | { success?: never; error: string; status: number }> {
  try {
    const result = await dbClient.query(
      "UPDATE sessions SET is_active = FALSE WHERE user_uuid = $1 AND session_id != $2 AND is_active = TRUE RETURNING session_id",
      [user_uuid, session_id]
    )
    return { success: true, deletedCount: result.rowCount ?? 0, status: 200 }
  } catch (error) {
    console.error("Error in terminateAllOtherSessions:", error)
    return {
      error: "Failed to terminate sessions due to a server error.",
      status: 500,
    }
  }
}

/**
 * Terminates every active session for a user by marking them all inactive —
 * no exclusion. Used when disabling an account, so the user is logged out
 * everywhere at once.
 *
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user whose sessions to end.
 * @returns {Promise<object>} `{ success: true, deletedCount, status: 200 }` or `{ error, status }`.
 */
export async function terminateAllSessions(
  dbClient: DbClient,
  user_uuid: string
): Promise<{ success: true; error?: never; deletedCount: number; status: 200 } | { success?: never; error: string; status: number }> {
  try {
    const result = await dbClient.query(
      "UPDATE sessions SET is_active = FALSE WHERE user_uuid = $1 AND is_active = TRUE RETURNING session_id",
      [user_uuid]
    )
    return { success: true, deletedCount: result.rowCount ?? 0, status: 200 }
  } catch (error) {
    console.error("Error in terminateAllSessions:", error)
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
export async function readSessions(
  dbClient: DbClient,
  user_uuid: string
): Promise<{ success: true; error?: never; sessions: SessionRow[]; status: 200 } | { success?: never; error: string; status: number }> {
  try {
    const result = await dbClient.query(
      "SELECT session_id, created_at, expires_at, is_active, user_agent, ip_address, ip_country FROM sessions WHERE user_uuid = $1 ORDER BY created_at DESC",
      [user_uuid]
    )
    return { success: true, sessions: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in readSessions:", error)
    return {
      error: "Failed to list sessions due to a server error.",
      status: 500,
    }
  }
}
