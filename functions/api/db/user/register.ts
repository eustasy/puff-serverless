import { registerUser, loginUser } from "../../../../src/users.js"
import { minPasswordLength } from "../../../../src/passwords.js"
import { loginOutcomeResponse } from "../../../../src/utilities/login-response.js"
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const name = formdata.get("name")
  const pw = formdata.get("pw")

  // Basic validation for required fields
  if (
    typeof email !== "string" ||
    typeof name !== "string" ||
    typeof pw !== "string" ||
    !email ||
    !name ||
    !pw
  ) {
    return new Response(
      '<p class="result-negative">Name, email, and password are required.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const results = await registerUser(dbClient, context.env, name, email, pw)
    if (results && results.success) {
      await emitFromContext(context, {
        event_type: EVENTS.ACCOUNT_REGISTERED,
        actor_user_uuid: results.user_uuid,
        target_user_uuid: results.user_uuid,
        target_label: results.email,
      })
      // Redirect to login page on successful registration
      return new Response(null, {
        status: 303, // See Other, to redirect after POST
        headers: {
          "HX-Redirect": "/login?code=registration_success",
        },
      })
    } else {
      // This case might be hit if registerUser returns something unexpected without throwing an error
      return new Response(
        '<p class="result-negative">Registration failed. Please try again.</p>',
        {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
  } catch (error) {
    console.error("Error in registerUser endpoint:", error)
    if (
      error instanceof Error &&
      error.message === "Email is already registered."
    ) {
      // The email is taken. If the supplied password also matches the existing
      // account, this is a returning user who forgot they already had one —
      // log them in rather than erroring (issue #20). registerUser threw
      // before creating anything, so there is no partial state to undo.
      const user_agent = context.request.headers.get("User-Agent") || ""
      const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
      const ip_country = context.request.headers.get("CF-IPCountry") || ""
      const loginResult = await loginUser(
        dbClient,
        email,
        pw,
        user_agent,
        ip_address,
        ip_country,
        minPasswordLength(context.env)
      )
      if (!loginResult.error) {
        // Same outcome as a normal login: a session, or the 2FA /
        // password-upgrade step.
        return await loginOutcomeResponse(
          dbClient,
          context.env,
          loginResult,
          context.request
        )
      }
      // Password did not match the existing account — keep the generic
      // conflict response, revealing nothing about the password.
      return new Response(
        '<p class="result-negative">Email is already registered.</p>',
        {
          status: 409, // 409 Conflict is appropriate for existing email
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    return new Response(
      '<p class="result-negative">An unexpected error occurred during registration.</p>',
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
