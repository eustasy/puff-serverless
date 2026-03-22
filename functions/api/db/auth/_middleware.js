import { getCookie } from "../../../../src/utilities/headers.js"
import { verifyTokenAndGetUser } from "../../../../src/sessions.js"

/**
 * Cloudflare Pages middleware to authenticate a user based on a session token from cookies.
 * It expects `context.data.dbClient` to be populated by a preceding middleware (e.g., databaseConnectionMiddleware).
 *
 * On successful authentication:
 *  - Populates `context.data.user_uuid` with the authenticated user's UUID.
 *  - Calls `context.next()` to proceed to the next handler in the chain.
 *
 * On authentication failure (e.g., no token, invalid token, token verification error):
 *  - Returns a `Response` object with an appropriate HTML error message and HTTP status code (e.g., 401).
 *
 * On internal server error (e.g., `dbClient` not found in context, unexpected error during processing):
 *  - Returns a `Response` object with an HTML error message and HTTP status code 500 or 503.
 *
 * @param {object} context The Cloudflare Pages function context.
 * @param {Request} context.request The incoming request object.
 * @param {object} context.env Environment bindings.
 * @param {object} context.data A mutable object to pass data between middleware.
 * @param {Function} context.next A function to invoke the next middleware or the request handler.
 * @returns {Promise<Response>} A `Response` object or the result of `await context.next()`.
 */
async function sessionAuthWithCookie(context) {
  const { request, data, next } = context

  if (!data || !data.dbClient) {
    console.error(
      "CRITICAL: sessionAuthWithCookie - dbClient not found in context.data. Ensure database middleware runs before auth middleware."
    )
    return new Response(
      `<h1 class="result-negative">Server Error</h1>
      <p>A configuration problem prevented us from processing your request. Please try again later.</p>`,
      {
        status: 503, // Service Unavailable
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  const dbClient = data.dbClient

  try {
    const cookieHeader = request.headers.get("Cookie")
    const sessionToken = await getCookie(cookieHeader, "session_token")

    if (!sessionToken) {
      return new Response(
        `<h1 class="result-negative">Authentication Required</h1>
        <p>No session token provided. Please log in.</p>`,
        {
          status: 401,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const ip_country = request.headers.get("CF-IPCountry")
    const authResult = await verifyTokenAndGetUser(dbClient, sessionToken, ip_country)

    if (authResult && authResult.user_uuid) {
      data.user_uuid = authResult.user_uuid // Set user_uuid in context.data for downstream handlers
      return next() // Authentication successful, proceed
    } else {
      // Handle specific errors from verifyTokenAndGetUser or a generic invalid token message
      const errorMessage =
        authResult && authResult.error
          ? authResult.error
          : "Invalid session token."
      const errorStatus =
        authResult && authResult.status ? authResult.status : 401

      // Consider logging the actual authResult.error if it's different from the message shown to user
      if (authResult && authResult.error && authResult.error !== errorMessage) {
        console.warn(
          `sessionAuthWithCookie: Authentication failed. Internal error: ${authResult.error}, Status: ${authResult.status}`
        )
      }

      return new Response(
        `<h1 class="result-negative">Authentication Failed</h1>
        <p>${errorMessage}.</p>
        <p>Please log in again.</p>`,
        {
          status: errorStatus,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
  } catch (error) {
    console.error(
      "sessionAuthWithCookie: Error during session authentication:",
      error
    )
    return new Response(
      `<h1 class="result-negative">Server Error</h1>
      <p>An unexpected error occurred during authentication. Please try again later.</p>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

// This will apply the sessionAuthWithCookie middleware to all requests under /api/db/auth.
export const onRequest = [sessionAuthWithCookie]
