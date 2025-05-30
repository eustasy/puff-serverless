import { user_exists } from "../../../src/users.js"

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  const email = searchParams.get("email")

  if (!email) {
    return new Response("Email parameter is missing.", { status: 400 })
  }

  try {
    const count = await user_exists(context, email) // user_exists is now async and uses pg
    // const results = { // This part is not strictly needed for the current response logic
    //   email: email,
    //   count: count,
    //   bool: Boolean(count),
    // }
    if (count > 0) {
      return new Response(
        '<span class="result-negative">This email is already registered.</span>'
      )
    }
    return new Response("", { headers: { "Content-Type": "text/html" } }) // Ensure empty response is HTML
  } catch (error) {
    console.error("Error in user_exists endpoint:", error)
    // It's good practice to not expose raw error messages to the client
    return new Response("Error checking email existence.", { status: 500 })
  }
}
