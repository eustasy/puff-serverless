import { user_login } from "./../../src/users.js"

export async function onRequest(context) {
  const formdata = await context.request.formData()
  const email = await formdata.get("email")
  const pw = await formdata.get("pw")
  const results = await user_login(context, email, pw)
  return new Response(
    results,
    { 
      status: results.error ? 401 : 200,
      headers: { "Content-Type": "application/json" },
    }
  )
}