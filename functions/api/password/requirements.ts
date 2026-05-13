import { password_requirements_html } from "../../../src/passwords.js"

export const onRequestPost: Handler = async (context) => {
  const pw = (await context.request.formData()).get("pw")
  let response_html = await password_requirements_html(pw)
  return new Response(response_html)
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
