import { verifyEmailByToken } from "../../../src/emails.js"

export async function onRequestGet(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in verify.js. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const { searchParams } = new URL(context.request.url)
  const tokenValue = searchParams.get("token")

  if (!tokenValue) {
    return new Response(
      JSON.stringify({ error: "Verification token is missing." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    const result = await verifyEmailByToken(context, tokenValue)

    if (result.error) {
      return new Response(
        JSON.stringify({ error: result.message }),
        { status: result.status || 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Success
    return new Response(
      JSON.stringify({ message: result.message }),
      { status: result.status || 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error in verify email endpoint:", error)
    return new Response(
      JSON.stringify({ error: "An internal server error occurred during email verification." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") {
    return await onRequestGet(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "application/json" },
  })
}
