import { user_exists } from "./../../src/users.js"

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  const email = searchParams.get("email")
  const count = await user_exists(context, email)
  const results = {
    email: email,
    count: count,
    bool: Boolean(count),
  }
  if (count > 0) {
    return new Response(
      '<span class="result-negative">This email is already registered.</span>'
    )
  }
  return new Response("")
}
