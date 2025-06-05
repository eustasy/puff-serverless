import { authenticator } from "otplib"
const { Client } = require("pg")
import { readToken, usedToken } from "../../../src/tokens.js"
import { getCookie } from "../../../src/utilities.js"
import { read2fa, used2fa } from "../../../src/2fa.js"
import { createSession } from "../../../src/sessions.js"

export async function onRequestPost(context) {
  // Step 1: Get the TOTP verification token from the cookie
  const cookieHeader = context.request.headers.get("Cookie")
  const totpVerificationToken = await getCookie(
    cookieHeader,
    "totp_verification_token"
  )

  if (!totpVerificationToken) {
    return new Response(
      '<p class="result-negative">Error: Missing 2FA verification token. Please try logging in again.</p>',
      {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area", // Assuming a similar message area on the /2fa page
        },
      }
    )
  }

  // Step 2: Parse form data for TOTP code
  let formData
  try {
    formData = await context.request.formData()
  } catch (e) {
    return new Response(
      '<p class="result-negative">Error: Invalid request body.</p>',
      {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      }
    )
  }
  const totp_code = formData.get("otp")

  // Step 3: Input Validation for TOTP code
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      '<p class="result-negative">Error: TOTP code is missing or invalid.</p>',
      {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      }
    )
  }

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    await client.connect()

    // Step 4: Read and validate the TOTP verification token
    const tokenDataResult = await readToken(context, totpVerificationToken)

    if (tokenDataResult.error || !tokenDataResult.token) {
      return new Response(
        '<p class="result-negative">Error: Invalid or expired 2FA verification token. Please try logging in again.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    const { user_uuid, token_type, expires_at, is_used } = tokenDataResult.token

    if (token_type !== "totp_verification_pending") {
      return new Response(
        '<p class="result-negative">Error: Invalid token type. Please try logging in again.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    if (new Date(expires_at) < new Date()) {
      return new Response(
        '<p class="result-negative">Error: 2FA verification token has expired. Please try logging in again.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    if (is_used) {
      return new Response(
        '<p class="result-negative">Error: 2FA verification token has already been used. Please try logging in again.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    // Step 5: Retrieve 2FA Secret from 'secrets' table and check if 2FA is enabled
    const secretRecord = await read2fa(context, user_uuid)

    if (!secretRecord || !secretRecord.secret_value) {
      return new Response(
        JSON.stringify({
          error:
            "2FA setup not found for this user. Please ensure 2FA is configured.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (secretRecord.is_enabled !== true) {
      return new Response(
        JSON.stringify({ error: "2FA is not enabled for this account." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // "Decrypt" the secret_value
    if (!secretRecord.secret_value.startsWith("sim_encrypted::")) {
      console.error(
        `Invalid secret_value format for user ${user_uuid} of type 'totp_secret'.`
      )
      return new Response(
        JSON.stringify({ error: "Internal error with 2FA secret storage." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    const storedSecret = secretRecord.secret_value.replace(
      "sim_encrypted::",
      ""
    )

    // Step 6: Verify TOTP Code
    const isValid = authenticator.check(totp_code, storedSecret)
    if (!isValid) {
      return new Response(
        '<p class="result-negative">Invalid 2FA code. Please try again.</p>',
        {
          status: 401, // Unauthorized
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    // Step 7: On Successful TOTP Verification, mark token as used, update secret_last_used, and create a new session
    const markTokenUsedResult = await usedToken(context, totpVerificationToken)
    if (markTokenUsedResult.error) {
      console.error(
        "Error marking TOTP token as used:",
        markTokenUsedResult.message
      )
      // Decide if this is a critical failure or if session creation can proceed
      // For now, let's treat it as critical to prevent token reuse issues.
      return new Response(
        '<p class="result-negative">Error finalizing 2FA. Please try again.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    used2fa(context, user_uuid)

    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""

    const sessionResult = await createSession(
      client,
      user_uuid,
      user_agent,
      ip_address
    )

    if (sessionResult.session_id) {
      const session_id = sessionResult.session_id
      const expires_at = sessionResult.expires_at

      const sessionCookieOptions = [
        `session_token=${session_id};`,
        "Path=/",
        "HttpOnly",
        "Secure",
        `Expires=${new Date(expires_at).toUTCString()}`,
        "SameSite=Lax",
      ]

      // Clear the totp_verification_token cookie
      const clearTotpTokenCookieOptions = [
        "totp_verification_token=;",
        "Path=/",
        "HttpOnly",
        "Secure",
        "Max-Age=0",
        "SameSite=Lax",
      ]

      return new Response(
        '<p class="result-positive">Login successful! Redirecting...</p>',
        {
          status: 200, // OK
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": sessionCookieOptions.join("; "),
            "Set-Cookie": clearTotpTokenCookieOptions.join("; "),
            "HX-Redirect": "/account",
          },
        }
      )
    } else {
      console.error("Error creating session:", sessionResult.error)
      return new Response(
        '<p class="result-negative">Error creating session. Please try again.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }
  } catch (error) {
    console.error("Error in 2FA login verification:", error)
    return new Response(
      '<p class="result-negative">An unexpected server error occurred during 2FA verification.</p>',
      {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      }
    )
  } finally {
    await client.end()
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context)
  }
  return new Response(
    '<p class="result-negative">Error: Method Not Allowed. Only POST requests are accepted for this action.</p>',
    {
      status: 405,
      headers: {
        "Allow": "POST",
        "Content-Type": "text/html",
        "HX-Retarget": "#message-area", // Ensure this matches the ID on your /2fa page
      },
    }
  )
}
