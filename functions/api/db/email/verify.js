import { verifyEmailByToken } from "../../../../src/emails.js"

export async function onRequestGet(context) {
  const dbClient = context.data.dbClient
  const { searchParams } = new URL(context.request.url)
  const token_value = searchParams.get("token")

  if (!token_value) {
    return new Response(
      JSON.stringify({ error: "Verification token is missing." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    const result = await verifyEmailByToken(dbClient, token_value)

    if (result.error) {
      return new Response(JSON.stringify({ error: result.message }), {
        status: result.status || 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Redirect to login page on successful email verification
    return new Response(null, {
      status: 303,
      headers: {
        "HX-Redirect": "/login?code=email_verification_success",
      },
    })
  } catch (error) {
    console.error("Error in verify email endpoint:", error)
    return new Response(
      JSON.stringify({
        error: "An internal server error occurred during email verification.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
