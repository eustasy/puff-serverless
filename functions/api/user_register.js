import { user_register } from "./../../src/users.js"

export async function onRequest(context) {
  // Step 0. Prep work
  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const name = formdata.get("name")
  const pw = formdata.get("pw")
  const results = user_register(context, name, email, pw)
  return Response.json(results)
}
