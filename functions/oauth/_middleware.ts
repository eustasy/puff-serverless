// DB-connection middleware for /oauth/* routes. The cross-origin write guard
// from /api/_middleware.ts is deliberately omitted — OAuth endpoints are
// by design called cross-site (by client apps for /oauth/token, by users
// arriving from a client app for /oauth/authorize), so requiring same-origin
// would break the protocol.

import { Client } from "pg"

export const onRequest: Handler = async (context) => {
  if (!context || !context.env || !context.env.HYPERDRIVE || !context.env.HYPERDRIVE.connectionString) {
    console.error("CRITICAL: Hyperdrive binding [HYPERDRIVE] not found in /oauth middleware.")
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description: "Database not configured.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    )
  }

  if (!context.data) context.data = {}

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    context.data.dbClient = client
    return await context.next()
  } catch (error) {
    console.error("/oauth middleware: connection or handler error:", error)
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description: "Internal error.",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    )
  } finally {
    if (context.data.dbClient) {
      try {
        await context.data.dbClient.end()
      } catch (endError) {
        console.error("/oauth middleware: error closing client:", endError)
      }
    }
  }
}
