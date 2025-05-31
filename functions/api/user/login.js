import { user_login } from "../../../src/users.js"

export async function onRequestPost(context) {
  try {
    const formdata = await context.request.formData() // Can throw if request body is not FormData
    const email = formdata.get("email")
    const pw = formdata.get("pw")

    if (!email || !pw) {
      return new Response("Email and password are required.", { status: 400 })
    }

    const loginResult = await user_login(context, email, pw) // Call user_login without client

    // Handle error or 2FA required cases first
    if (loginResult.error) {
      return new Response(loginResult.message || "Login failed", { status: loginResult.status || 500 })
    }

    if (loginResult.totp_required) {
      // For HTMX, we might want to redirect to a TOTP page or return specific HTMX headers
      // to swap in a TOTP form. For now, returning JSON with a clear message.
      // A more HTMX-idiomatic response might be a partial HTML snippet for the TOTP form.
      return new Response(JSON.stringify({
        message: loginResult.message,
        user_uuid: loginResult.user_uuid,
        next_step: "totp",
      }), {
        status: loginResult.status || 200, // Could be 202 if preferred
        headers: { "Content-Type": "application/json" },
        // Example: HX-Trigger: 'showTotpForm'
        // Example: HX-Push: '/login/totp' (if redirecting to a new URL for TOTP)
      })
    }

    // If login is successful and session is created (loginResult contains session_id)
    if (loginResult.session_id) {
      const cookieOptions = [
        `session_token=${loginResult.session_id};`,
        "Path=/",
        "HttpOnly",
        "Secure",
        `Expires=${new Date(loginResult.expires_at).toUTCString()}`,
        "SameSite=Lax", // Good default for session cookies
      ]

      return new Response("Login successful. Session started.", {
        status: 200,
        headers: {
          "Set-Cookie": cookieOptions.join("; "),
          "HX-Redirect": "/", // Redirect to dashboard or home page
        },
      })
    } else {
      // Fallback for unexpected structure from user_login if it wasn't an error/totp/success case
      console.error("Unexpected login result structure after handling known cases:", loginResult)
      return new Response("An unexpected error occurred during login.", {
        status: 500,
      })
    }

  } catch (error) {
    console.error("Error in user_login endpoint:", error)
    // Check if the error is from context.request.formData()
    // This can happen if the request body is not valid FormData (e.g., JSON sent to a FormData endpoint)
    // or if there are network issues reading the stream.
    // A simple check for TypeError might be too broad, but specific messages can be checked.
    if (error.message && (error.message.toLowerCase().includes("formdata") || error.message.toLowerCase().includes("request body"))) {
        return new Response("Invalid request format. Expected form data.", { status: 400 });
    }
    return new Response("An unexpected server error occurred.", {
      status: 500,
    })
  } 
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
