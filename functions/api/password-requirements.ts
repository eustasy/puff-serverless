import {
  passwordConfig,
  passwordRequirementsHtml,
} from "../../src/passwords.js"

export const onRequestPost: Handler = async (context) => {
  const pw = (await context.request.formData()).get("pw")
  if (typeof pw !== "string") {
    return new Response(
      '<p class="result-negative">Password is required.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  const response_html = await passwordRequirementsHtml(
    pw,
    passwordConfig(context.env)
  )
  return new Response(response_html)
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
