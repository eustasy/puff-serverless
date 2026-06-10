import { existsEmail } from "../../../src/emails.js"

export const onRequestGet: Handler = async (context) => {
  const clientIP = context.request.headers.get("CF-Connecting-IP") || "unknown"
  const { success } = await context.env.EMAIL_CHECK_RL.limit({ key: clientIP })
  if (!success) {
    return new Response('<span class="result-negative">Too many requests. Please slow down.</span>', {
      status: 429,
      headers: { "Content-Type": "text/html" },
    })
  }

  const dbClient = context.data.dbClient!

  const { searchParams } = new URL(context.request.url)
  const email = searchParams.get("email")

  if (!email) {
    return new Response("Email parameter is missing.", { status: 400 })
  }

  try {
    const result = await existsEmail(dbClient, email)
    if (result.error) {
      return new Response("Error checking email existence.", { status: 500 })
    }
    if (result.exists) {
      return new Response('<span class="result-negative">This email is already registered.</span>')
    }
    return new Response("", { headers: { "Content-Type": "text/html" } })
  } catch (error) {
    console.error("Error in user_exists endpoint:", error)
    return new Response("Error checking email existence.", { status: 500 })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
