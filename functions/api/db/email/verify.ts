import { verifyEmailByToken } from "../../../../src/emails.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient
  const { searchParams } = new URL(context.request.url)
  const token_value = searchParams.get("token")

  if (!token_value) {
    return new Response(
      '<p class="result-negative">Verification token is missing.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  try {
    const result = await verifyEmailByToken(dbClient, token_value)

    if (result.error) {
      return new Response(`<p class="result-negative">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Redirect to login page on successful email verification.
    // HTMX swaps and direct browser navigation need different headers: HTMX
    // honors HX-Redirect for a JS-driven nav; the browser honors a standard
    // Location: header on a 303. Sending both would make browser XHR auto-follow
    // the redirect before HTMX sees HX-Redirect, jamming the /login HTML page
    // into the target element. So branch on the HX-Request header HTMX sets on
    // every request it makes.
    const redirectTarget = "/login?code=email_verification_success"
    const isHtmxRequest = context.request.headers.get("HX-Request") === "true"
    return new Response(null, {
      status: 303,
      headers: isHtmxRequest
        ? { "HX-Redirect": redirectTarget }
        : { Location: redirectTarget },
    })
  } catch (error) {
    console.error("Error in verify email endpoint:", error)
    return new Response(
      '<p class="result-negative">An internal server error occurred during email verification.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
