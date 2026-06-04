import { loginUser } from "../../../../src/users.js"
import { minPasswordLength } from "../../../../src/passwords.js"
import { loginOutcomeResponse } from "../../../../src/utilities/login-response.js"
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  try {
    const formdata = await context.request.formData()
    const email = formdata.get("email")
    const pw = formdata.get("pw")

    if (!email || !pw || typeof email !== "string" || typeof pw !== "string") {
      return new Response('<p class="result-negative">Email and password are required.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""
    const loginResult = await loginUser(dbClient, email, pw, user_agent, ip_address, ip_country, minPasswordLength(context.env))

    if (loginResult.error) {
      await emitFromContext(context, {
        event_type: EVENTS.ACCOUNT_LOGIN_FAILED,
        event_outcome: "failure",
        actor_user_uuid: null,
        target_label: email,
        event_metadata: { status: loginResult.status ?? 500 },
      })
      return new Response(`<p class="result-negative">${loginResult.message || "Login failed"}</p>`, {
        status: loginResult.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Only emit `account.login.success` once a session is actually granted;
    // 2FA-required / password-upgrade-required are intermediate states whose
    // own completion handlers will emit success themselves.
    if ("session_id" in loginResult && typeof loginResult.session_id === "string") {
      await emitFromContext(context, {
        event_type: EVENTS.ACCOUNT_LOGIN_SUCCESS,
        actor_user_uuid: loginResult.user_uuid,
        target_user_uuid: loginResult.user_uuid,
      })
    }

    // Session cookie, or redirect into the 2FA / password-upgrade step.
    return await loginOutcomeResponse(dbClient, context.env, loginResult, context.request)
  } catch (error) {
    console.error("Error in loginUser endpoint:", error)
    if (
      error instanceof Error &&
      (error.message.toLowerCase().includes("formdata") || error.message.toLowerCase().includes("request body"))
    ) {
      return new Response('<p class="result-negative">Invalid request format. Expected form data.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }
    return new Response('<p class="result-negative">An unexpected server error occurred.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
