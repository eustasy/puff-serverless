import { user_login } from "../../../../src/users.js"
import {
  createLoginToken,
  createPasswordUpgradeToken,
} from "../../../../src/tokens.js"
import { getMinPasswordLength } from "../../../../src/passwords.js"

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

    if (loginResult.totp_required) {
      // Create a short-lived token for the TOTP step
      const tokenResult = await createLoginToken(
        dbClient,
        loginResult.user_uuid
      )

      if (tokenResult.error) {
        console.error("Error creating TOTP token:", tokenResult.message)
        return new Response(
          '<p class="result-negative">Error initiating 2FA. Please try again.</p>',
          {
            status: 500,
            headers: { "Content-Type": "text/html" },
          }
        )
      }

      const totpTokenCookieOptions = [
        `totp_verification_token=${tokenResult.token_value};`,
        "Path=/",
        "HttpOnly",
        // 15 minutes — must match the TTL set by createLoginToken
        "Max-Age=900",
        `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      ]
      if (context.env.SECURE_COOKIE) {
        totpTokenCookieOptions.push("Secure")
      }
      // Redirect to a TOTP verification page
      return new Response(null, {
        status: 303,
        headers: {
          "Set-Cookie": totpTokenCookieOptions.join("; "),
          "HX-Redirect": "/2fa",
        },
      })
    }

    if (loginResult.password_upgrade_required) {
      // The password is correct but shorter than the current minimum. Issue a
      // short-lived token and send the user to a forced password-change page;
      // no session is granted until they set a compliant password.
      const tokenResult = await createPasswordUpgradeToken(
        dbClient,
        loginResult.user_uuid
      )

      if (tokenResult.error) {
        console.error(
          "Error creating password-upgrade token:",
          tokenResult.message
        )
        return new Response(
          '<p class="result-negative">Error initiating password upgrade. Please try again.</p>',
          {
            status: 500,
            headers: { "Content-Type": "text/html" },
          }
        )
      }

      const upgradeTokenCookieOptions = [
        `password_upgrade_token=${tokenResult.token_value};`,
        "Path=/",
        "HttpOnly",
        // 15 minutes — must match the TTL set by createPasswordUpgradeToken
        "Max-Age=900",
        `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      ]
      if (context.env.SECURE_COOKIE) {
        upgradeTokenCookieOptions.push("Secure")
      }
      return new Response(null, {
        status: 303,
        headers: {
          "Set-Cookie": upgradeTokenCookieOptions.join("; "),
          "HX-Redirect": "/password-upgrade",
        },
      })
    }

    if (loginResult.session_id) {
      const cookieOptions = [
        `session_token=${loginResult.session_id};`,
        "Path=/",
        "HttpOnly",
        `Max-Age=${context.env.SESSION_MAX_AGE_SECONDS || 2592000}`,
        `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      ]
      if (context.env.SECURE_COOKIE) {
        cookieOptions.push("Secure")
      }

      return new Response(null, {
        status: 303,
        headers: {
          "Set-Cookie": cookieOptions.join("; "),
          "HX-Redirect": "/account",
        },
      })
    } else {
      console.error(
        "Unexpected login result structure after handling known cases:" //,
        //loginResult
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
