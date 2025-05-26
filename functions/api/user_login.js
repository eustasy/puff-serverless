import { user_login } from "./../../src/users.js"

export async function onRequest(context) {
  const formdata = await context.request.formData()
  const email = await formdata.get("email")
  const pw = await formdata.get("pw")
  const loginResponse = await user_login(context, email, pw)
  return loginResponse
}
