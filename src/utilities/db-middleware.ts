import { Client } from "pg"

export function createDbMiddleware(label: string): Handler {
  return async (context) => {
    if (!context?.env?.HYPERDRIVE?.connectionString) {
      console.error(`CRITICAL: Hyperdrive binding [HYPERDRIVE] not found in ${label} middleware.`)
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
      console.error(`${label}: connection or handler error:`, error)
      return new Response('<h1 class="result-negative">Server Error</h1><p>An unexpected error occurred. Please try again later.</p>', {
        status: 500,
        headers: { "Content-Type": "text/html" },
      })
    } finally {
      if (context.data.dbClient) {
        try {
          await context.data.dbClient.end()
        } catch (endError) {
          console.error(`${label}: error closing client:`, endError)
        }
      }
    }
  }
}
