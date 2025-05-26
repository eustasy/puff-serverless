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
    return new Response("This email is already registered.")
  }
  return new Response("")
}
