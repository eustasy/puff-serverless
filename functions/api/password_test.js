import { password_requirements_html } from "./../../src/passwords.js"

export async function onRequest(context) {
  const pw = (await context.request.formData()).get("pw")
  let response_html = await password_requirements_html(pw)
  return new Response(response_html)
}
