// DB connection for the federated-login endpoints under /login/[provider]/*.
// Mirrors the database side of /api/db/_middleware.ts but skips the
// cross-origin write guard — every endpoint here is a GET (browser top-level
// navigation away to the provider and back), so there is no state-changing
// surface to guard.

import { Client } from "pg"

const databaseConnectionMiddleware: Handler = async (context) => {
  if (!context.env?.HYPERDRIVE?.connectionString) {
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>A configuration problem prevented us from processing your request.</p>',
      { status: 503, headers: { "Content-Type": "text/html" } }
    )
  }
  if (!context.data) context.data = {}

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    context.data.dbClient = client
    return await context.next()
  } catch (error) {
    console.error("login/_middleware DB error:", error)
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>An unexpected error occurred. Please try again later.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  } finally {
    if (context.data.dbClient) {
      try {
        await context.data.dbClient.end()
      } catch (endError) {
        console.error("login/_middleware close error:", endError)
      }
    }
  }
}

export const onRequest = [databaseConnectionMiddleware]
