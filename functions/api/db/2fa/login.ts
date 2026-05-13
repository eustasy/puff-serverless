import { verify } from "otplib"
import { readToken, usedToken } from "../../../../src/tokens.js"
import { getCookie } from "../../../../src/utilities/headers.js"
import { read2fa, used2fa } from "../../../../src/2fa.js"
import { createSession } from "../../../../src/sessions.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient
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

  try {
    // Step 4: Read and validate the TOTP verification token
    const tokenDataResult = await readToken(dbClient, totpVerificationToken)

    if (!tokenDataResult.success) {
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
            // Clear the expired/invalid cookie
            "Set-Cookie": `totp_verification_token=; HttpOnly; Path=/; Max-Age=0; SameSite=${
              context.env.COOKIE_SAMESITE || "Lax"
            }${context.env.SECURE_COOKIE ? "; Secure" : ""}`,
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
            "Set-Cookie": `totp_verification_token=; HttpOnly; Path=/; Max-Age=0; SameSite=${
              context.env.COOKIE_SAMESITE || "Lax"
            }${context.env.SECURE_COOKIE ? "; Secure" : ""}`,
          },
        }
      )
    }

    // Step 5: Retrieve the user's 2FA secret
    const twoFaResult = await read2fa(dbClient, user_uuid)

    if (!twoFaResult.success || !twoFaResult.twoFactor.secret_value) {
      return new Response(
        JSON.stringify({
          error:
            "2FA setup not found for this user. Please ensure 2FA is configured.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const twoFaData = twoFaResult.twoFactor

    if (twoFaData.is_enabled !== true) {
      return new Response(
        JSON.stringify({ error: "2FA is not enabled for this account." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // "Decrypt" the secret_value
    if (!twoFaData.secret_value.startsWith("sim_encrypted::")) {
      console.error(
        `Invalid secret_value format for user ${user_uuid} of type 'totp_secret'.`
      )
      return new Response(
        JSON.stringify({ error: "Internal error with 2FA secret storage." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    const storedSecret = twoFaData.secret_value.replace("sim_encrypted::", "")

    // Step 6: Verify TOTP Code
    const verifyResult = await verify({
      token: totp_code,
      secret: storedSecret,
    })

    if (!verifyResult.valid) {
      // Optionally, implement a rate-limiter or attempt counter here
      return new Response(
        '<p class="result-negative">Error: Invalid TOTP code. Please try again.</p>',
        {
          status: 401, // Unauthorized
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    // Step 7: Mark the TOTP verification token as used
    const markUsedResult = await usedToken(dbClient, totpVerificationToken)
    if (markUsedResult.error) {
      // Log this error but proceed, as the user has successfully authenticated with TOTP.
      // The main risk is token reuse if this fails, but the token is short-lived.
      console.error(
        `Failed to mark TOTP verification token ${totpVerificationToken} as used for user ${user_uuid}.`,
        markUsedResult.message
      )
      // Depending on security posture, you might choose to return an error here.
    }

    // Step 8: Update the last used timestamp for the 2FA secret
    const updateLastUsedResult = await used2fa(dbClient, user_uuid)
    if (!updateLastUsedResult.success) {
      // Log this error but proceed.
      console.error(
        `Failed to update last used timestamp for 2FA for user ${user_uuid}.`,
        updateLastUsedResult.error
      )
    }

    // Step 9: Create a new session for the user
    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""

    const sessionResult = await createSession(
      dbClient,
      user_uuid,
      user_agent,
      ip_address,
      ip_country
    )

    if (!sessionResult.success) {
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

    // Step 10: Return success response with session cookie and redirect
    const headers = new Headers({
      "Location": "/account", // Redirect to the account page
      "HX-Redirect": "/account",
      "Content-Type": "text/html", // Though with redirect, body might not be shown
    })

    const cookieOptions = [
      `session_token=${sessionResult.session_id}`,
      "HttpOnly",
      "Path=/",
      `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      `Max-Age=${context.env.SESSION_MAX_AGE_SECONDS || 2592000}`, // Default to 30 days
    ]
    if (context.env.SECURE_COOKIE) {
      cookieOptions.push("Secure")
    }
    headers.append("Set-Cookie", cookieOptions.join("; "))

    // Clear the totp_verification_token cookie as it's no longer needed
    const clearTotpCookieOptions = [
      `totp_verification_token=;`,
      "HttpOnly",
      "Path=/",
      `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
      "Max-Age=0", // Expire immediately
    ]
    if (context.env.SECURE_COOKIE) {
      clearTotpCookieOptions.push("Secure")
    }
    headers.append("Set-Cookie", clearTotpCookieOptions.join("; "))

    return new Response(
      '<p class="result-positive">Login successful! Redirecting...</p>',
      {
        status: 303, // See Other, appropriate for redirect after POST
        headers: headers,
      }
    )
  } catch (error) {
    console.error("Error during 2FA login:", error)
    return new Response(
      '<p class="result-negative">An unexpected error occurred. Please try again.</p>',
      {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
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
