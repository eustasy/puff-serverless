import { password_requirements } from "../../../src/passwords.js"

export async function onRequest(context) {
  const pw = (await context.request.formData()).get("pw")
  let response_bool = await password_requirements(pw)
  return new Response(response_bool)
}
