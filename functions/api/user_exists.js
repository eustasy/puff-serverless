import { user_register } from "./../../src/users.js"

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let email = searchParams.get("email")
  const results = await user_exists(context, email)
  return new Response(results)
}
