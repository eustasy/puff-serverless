import { user_login } from "../../../src/users.js"

export async function onRequestPost(context) {
  try {
    const formdata = await context.request.formData()
    const email = formdata.get("email")
    const pw = formdata.get("pw")

    if (!email || !pw) {
      return new Response(
        '<p class="result-negative">Email and password are required.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const loginResult = await user_login(context, email, pw)

    if (loginResult.error) {
      return new Response(
        `<p class="result-negative">${loginResult.message || "Login failed"}</p>`,
        {
          status: loginResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    if (loginResult.totp_required) {
      // Store user_uuid in a short-lived cookie for the TOTP step
      const totpCookieOptions = [
        `totp_user_uuid=${loginResult.user_uuid};`,
        "Path=/",
        "HttpOnly",
        "Secure",
        `Max-Age=${5 * 60}`,
        "SameSite=Lax",
      ]
      // Redirect to a TOTP verification page or return HTML to swap in a TOTP form
      return new Response(null, {
        status: 303,
        headers: {
          "Set-Cookie": totpCookieOptions.join("; "),
          "HX-Redirect": "/2fa",
        },
      })
    }

    if (loginResult.session_id) {
      const cookieOptions = [
        `session_token=${loginResult.session_id};`,
        "Path=/",
        "HttpOnly",
        "Secure",
        `Expires=${new Date(loginResult.expires_at).toUTCString()}`,
        "SameSite=Lax",
      ]

      return new Response(null, {
        status: 303,
        headers: {
          "Set-Cookie": cookieOptions.join("; "),
          "HX-Redirect": "/account",
        },
      })
    } else {
      console.error(
        "Unexpected login result structure after handling known cases:",
        loginResult
      )
      return new Response(
        '<p class="result-negative">An unexpected error occurred during login.</p>',
        {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
  } catch (error) {
    console.error("Error in user_login endpoint:", error)
    if (
      error.message &&
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

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context)
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
