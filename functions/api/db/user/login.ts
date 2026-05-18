import { user_login } from "../../../../src/users.js"
import { getMinPasswordLength } from "../../../../src/passwords.js"
import { loginOutcomeResponse } from "../../../../src/utilities/login-response.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  try {
    const formdata = await context.request.formData()
    const email = formdata.get("email")
    const pw = formdata.get("pw")

    if (!email || !pw || typeof email !== "string" || typeof pw !== "string") {
      return new Response(
        '<p class="result-negative">Email and password are required.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""
    const loginResult = await user_login(
      dbClient,
      email,
      pw,
      user_agent,
      ip_address,
      ip_country,
      getMinPasswordLength(context.env)
    )

    if (loginResult.error) {
      return new Response(
        `<p class="result-negative">${loginResult.message || "Login failed"}</p>`,
        {
          status: loginResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    // Session cookie, or redirect into the 2FA / password-upgrade step.
    return await loginOutcomeResponse(dbClient, context.env, loginResult)
  } catch (error) {
    console.error("Error in user_login endpoint:", error)
    if (
      error instanceof Error &&
      (error.message.toLowerCase().includes("formdata") ||
        error.message.toLowerCase().includes("request body"))
    ) {
      return new Response(
        '<p class="result-negative">Invalid request format. Expected form data.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    return new Response(
      '<p class="result-negative">An unexpected server error occurred.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
