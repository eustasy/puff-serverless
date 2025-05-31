import { verifyEmailByToken } from "../../../src/emails.js"

export async function onRequestGet(context) {
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
      return new Response(JSON.stringify({ error: result.message }), {
        status: result.status || 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Redirect to login page on successful email verification
    return new Response(null, {
      status: 303,
      headers: {
        "HX-Redirect":
          "/login?message=Email verification successful. Please log in.",
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
  if (context.request.method === "GET") {
    return await onRequestGet(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "application/json" },
  })
}
