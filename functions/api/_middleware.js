import { Client } from "pg"

/**
 * Middleware to:
 * 1. Check for Hyperdrive configuration.
 * 2. Create a single pg.Client instance for the request.
 * 3. Attach the client to context.data.dbClient.
 * 4. Ensure the client is closed after the request is handled.
 */
async function databaseConnectionMiddleware(context) {
  // 1. Configuration Check
  if (
    !context ||
    !context.env ||
    !context.env.HYPERDRIVE ||
    !context.env.HYPERDRIVE.connectionString
  ) {
    console.error(
      "CRITICAL: Hyperdrive binding [HYPERDRIVE] not found in middleware. " +
        "Ensure it is configured in your wrangler.toml and Cloudflare Pages project settings."
    )
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>A configuration problem prevented us from processing your request. Please try again later.</p>',
      {
        status: 503, // Service Unavailable is more appropriate for config issues
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  // Initialize context.data if it doesn't already exist.
  if (!context.data) {
    context.data = {}
  }

  // 2. Create and connect the pg.Client
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    // 3. Attach the connected client to context.data
    context.data.dbClient = client

    // Proceed to the next function in the chain (API route handler)
    const response = await context.next()
    return response
  } catch (error) {
    console.error(
      "Middleware: Error during database client connection or downstream handler:",
      error
    )
    // If an error occurs, ensure the client is ended if it was created/connected.
    // This catch block is for errors during client.connect() or from context.next().
    // The finally block will also attempt to end the client.
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>An unexpected error occurred while processing your request. Please try again later.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  } finally {
    // 4. Ensure the client is closed after the request
    // This runs regardless of whether context.next() succeeded or threw an error,
    // as long as the client was successfully assigned to context.data.dbClient (implying connect was attempted and succeeded).
    if (context.data.dbClient) {
      try {
        await context.data.dbClient.end()
        // console.log("Middleware: Database client closed successfully.");
      } catch (endError) {
        console.error(
          "Middleware: Error while closing database client:",
          endError
        )
      }
    }
  }
}

// Define the middleware chain.
// This will apply the databaseConnectionMiddleware to all requests under /api.
// You can add other middleware functions to this array if needed in the future.
const onRequest = [databaseConnectionMiddleware]
