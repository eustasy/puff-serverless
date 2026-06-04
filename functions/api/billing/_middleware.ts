// DB-connection middleware for /api/billing/* routes (provider webhooks and
// app-credential usage ingest). Modelled on functions/oauth/_middleware.ts:
// opens a Hyperdrive pg client, attaches it to context.data, closes it in
// `finally`. No session auth and no cross-origin write guard — these endpoints
// are called by non-browser clients (Stripe, registered apps) authenticated by
// signature or app credentials, not by a cookie. The /api/db cross-origin
// guard lives under that subtree and does not apply here.

import { Client } from "pg"

export const onRequest: Handler = async (context) => {
  if (!context?.env?.HYPERDRIVE?.connectionString) {
    console.error("CRITICAL: Hyperdrive binding [HYPERDRIVE] not found in /api/billing middleware.")
    return new Response("Database not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    })
  }

  if (!context.data) context.data = {}

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    context.data.dbClient = client
    return await context.next()
  } catch (error) {
    console.error("/api/billing middleware: connection or handler error:", error)
    return new Response("Internal error.", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    })
  } finally {
    if (context.data.dbClient) {
      try {
        await context.data.dbClient.end()
      } catch (endError) {
        console.error("/api/billing middleware: error closing client:", endError)
      }
    }
  }
}
