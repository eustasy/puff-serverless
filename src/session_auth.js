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
  if (!token) {
    return { error: "Session token is missing.", status: 401 }
  }

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
      await client.query("DELETE FROM sessions WHERE session_id = $1", [token])
      return { error: "Session token expired.", status: 401 }
    }

    return { user_uuid: sessionRecord.user_uuid, status: 200 } // Valid session
  } catch (error) {
    console.error("Error during token verification:", error)
    return {
      error: "An internal server error occurred during session verification.",
      status: 500,
    }
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
  // Initialize context.data if it doesn't exist
  if (!context.data) {
    context.data = {}
  }

  // 2. Cookie Parsing
  const cookieHeader = context.request.headers.get("Cookie")
  const sessionToken = getCookie(cookieHeader, "session_token") // Standard cookie name for sessions

  let authResult = null

  if (sessionToken) {
    const client = new Client(context.env.HYPERDRIVE.connectionString)
    try {
      await client.connect()
      authResult = await verifyTokenAndGetUser(client, sessionToken)

      if (authResult && authResult.user_uuid) {
        context.data.user_uuid = authResult.user_uuid // Authentication successful, add user_uuid
      }
      // If authResult has an error, it will be handled by the requireAuth logic below.
    } catch (dbError) {
      console.error(
        "Database connection or query error in middleware:",
        dbError
      )
      authResult = {
        error: "An internal server error occurred during authentication.",
        status: 500,
      }
    } finally {
      // Ensure the client is defined and has a `connected` state or similar before ending
      // pg client's `end` can be called regardless of connection state.
      if (client) {
        await client.end()
      }
    }
  } else {
    // No session token found in cookies
    authResult = { error: "Session token not found in cookies.", status: 401 }
  }

  // 3. Handle `requireAuth` option
  if (options.requireAuth) {
    // Check if authentication was required and failed (no token, or token verification failed)
    if (!sessionToken || (authResult && authResult.error)) {
      const defaultErrorMessage =
        "Authentication required to access this resource."
      const defaultErrorStatus = 401

      const errorMessage =
        authResult && authResult.error ? authResult.error : defaultErrorMessage
      const errorStatus =
        authResult && authResult.status ? authResult.status : defaultErrorStatus

      let errorTitle = "Access Denied"
      let errorGuidance =
        '<p>Please <a href="/login.html">log in</a> to continue.</p>'

      if (errorStatus >= 500) {
        errorTitle = "Server Error"
        errorGuidance =
          "<p>We encountered an issue while trying to authenticate your session. Please try again later.</p>"
      }

      return new Response(
        `<h1>${errorTitle}</h1><p>${errorMessage}</p>${errorGuidance}`,
        {
          status: errorStatus,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    // If requireAuth is true and we are here, it means authentication was successful.
    // user_uuid is already in context.data.
  }

  // If requireAuth is false, or if requireAuth is true and authentication succeeded,
  // the request can proceed. context.data.user_uuid will be populated if auth was successful.
  return null // Signal to continue to the main Cloudflare Function handler
}
