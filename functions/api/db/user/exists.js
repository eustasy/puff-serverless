import { user_exists } from "../../../../src/users.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient

  const { searchParams } = new URL(context.request.url)
  const email = searchParams.get("email")

  if (!email) {
    return new Response("Email parameter is missing.", { status: 400 })
  }

  try {
    const count = await user_exists(dbClient, email)
    if (count > 0) {
      return new Response(
        '<span class="result-negative">This email is already registered.</span>'
      )
    }
    return new Response("", { headers: { "Content-Type": "text/html" } })
  } catch (error) {
    console.error("Error in user_exists endpoint:", error)
    return new Response("Error checking email existence.", { status: 500 })
  }
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
