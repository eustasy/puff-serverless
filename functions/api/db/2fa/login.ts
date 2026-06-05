import { verify } from "otplib"
import { readToken, consumeToken } from "../../../../src/tokens.js"
import { getCookie } from "../../../../src/utilities/headers.js"
import { readNext, clearNextCookie } from "../../../../src/utilities/next.js"
import { read2fa, used2fa } from "../../../../src/2fa.js"
import { createSession } from "../../../../src/sessions.js"
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  // Step 1: Get the TOTP verification token from the cookie
  const cookieHeader = context.request.headers.get("Cookie")
  const totpVerificationToken = await getCookie(cookieHeader, "totp_verification_token")

  if (!totpVerificationToken) {
    return new Response('<p class="result-negative">Error: Missing 2FA verification token. Please try logging in again.</p>', {
      status: 400,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#message-area", // Assuming a similar message area on the /2fa page
      },
    })
  }

  // Step 2: Parse form data for TOTP code
  let formData
  try {
    formData = await context.request.formData()
  } catch {
    return new Response('<p class="result-negative">Error: Invalid request body.</p>', {
      status: 400,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#message-area",
      },
    })
  }
  const totp_code = formData.get("otp")

  // Step 3: Input Validation for TOTP code
  if (!totp_code || typeof totp_code !== "string") {
    return new Response('<p class="result-negative">Error: TOTP code is missing or invalid.</p>', {
      status: 400,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#message-area",
      },
    })
  }

  try {
    // Step 4: Read and validate the TOTP verification token
    const tokenDataResult = await readToken(dbClient, totpVerificationToken)

    if (!tokenDataResult.success) {
      return new Response('<p class="result-negative">Error: Invalid or expired 2FA verification token. Please try logging in again.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }

    const { user_uuid, token_type, expires_at, is_used } = tokenDataResult.token

    if (token_type !== "totp_verification_pending") {
      return new Response('<p class="result-negative">Error: Invalid token type. Please try logging in again.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }

    if (new Date(expires_at) < new Date()) {
      return new Response('<p class="result-negative">Error: 2FA verification token has expired. Please try logging in again.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
          // Clear the expired/invalid cookie
          "Set-Cookie": `totp_verification_token=; HttpOnly; Path=/; Max-Age=0; SameSite=${
            context.env.COOKIE_SAMESITE || "Lax"
          }${context.env.SECURE_COOKIE ? "; Secure" : ""}`,
        },
      })
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
      return new Response('<p class="result-negative">Error: 2FA is not configured for this account. Please contact support.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }

    const twoFaData = twoFaResult.twoFactor

    if (twoFaData.is_enabled !== true) {
      return new Response('<p class="result-negative">Error: 2FA is not enabled for this account. Please contact support.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }

    // "Decrypt" the secret_value
    if (!twoFaData.secret_value.startsWith("sim_encrypted::")) {
      console.error(`Invalid secret_value format for user ${user_uuid} of type 'totp_secret'.`)
      return new Response('<p class="result-negative">Error: Internal server error. Please try again or contact support.</p>', {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }
    const storedSecret = twoFaData.secret_value.replace("sim_encrypted::", "")

    // Step 6: Verify TOTP Code
    const verifyResult = await verify({
      token: totp_code,
      secret: storedSecret,
      epochTolerance: 30, // accept ±1 time step for clock skew
    })

    if (!verifyResult.valid) {
      // Optionally, implement a rate-limiter or attempt counter here
      return new Response('<p class="result-negative">Error: Invalid TOTP code. Please try again.</p>', {
        status: 401, // Unauthorized
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }

    // Step 7: Record code and update last-used timestamp. used2fa does an
    // INSERT ON CONFLICT DO NOTHING into totp_used_codes — rowCount === 0
    // means this exact code was already accepted for this user within the
    // cleanup window, so reject. Runs before consumeToken so a replay does
    // not burn the pending-login token.
    const used2faResult = await used2fa(dbClient, user_uuid, totp_code)
    if (!used2faResult.success) {
      const isServerError = used2faResult.error === true
      return new Response(
        isServerError
          ? '<p class="result-negative">An unexpected error occurred. Please try again.</p>'
          : '<p class="result-negative">Error: TOTP code has already been used. Please wait for the next code and try again.</p>',
        {
          status: isServerError ? 500 : 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#message-area",
          },
        }
      )
    }

    // Step 8: Atomically consume the TOTP verification token. The readToken
    // above was a non-consuming check so a wrong TOTP code does not burn the
    // token; consuming only happens here, after a valid code. The atomic
    // UPDATE re-checks type/expiry/used, so a concurrent replay of the same
    // token cannot also reach session creation — exactly one consumer wins.
    // A failure is fatal (no longer swallowed): the user logs in again.
    const consumeResult = await consumeToken(dbClient, totpVerificationToken, "totp_verification_pending")
    if (!consumeResult.success) {
      return new Response('<p class="result-negative">Error: 2FA verification token is no longer valid. Please try logging in again.</p>', {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
          "Set-Cookie": `totp_verification_token=; HttpOnly; Path=/; Max-Age=0; SameSite=${
            context.env.COOKIE_SAMESITE || "Lax"
          }${context.env.SECURE_COOKIE ? "; Secure" : ""}`,
        },
      })
    }

    // Step 9: Create a new session for the user
    const user_agent = context.request.headers.get("User-Agent") || ""
    const ip_address = context.request.headers.get("CF-Connecting-IP") || ""
    const ip_country = context.request.headers.get("CF-IPCountry") || ""

    const sessionResult = await createSession(dbClient, user_uuid, user_agent, ip_address, ip_country)

    if (!sessionResult.success) {
      console.error("Error creating session:", sessionResult.error)
      return new Response('<p class="result-negative">Error creating session. Please try again.</p>', {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#message-area",
        },
      })
    }
    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_LOGIN_SUCCESS,
      actor_user_uuid: user_uuid,
      target_user_uuid: user_uuid,
      event_metadata: { factor: "totp" },
    })

    // Step 11: Return success response with session cookie and redirect.
    // Honour the `login_next` cookie (set by the root middleware when the
    // visitor was sent here from a session-gated page), then clear it.
    const next = await readNext(context.request)
    const destination = next || "/account"
    const headers = new Headers({
      "Location": destination,
      "HX-Redirect": destination,
      "Content-Type": "text/html", // Though with redirect, body might not be shown
    })
    if (next) {
      headers.append("Set-Cookie", clearNextCookie(context.env))
    }

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

    return new Response('<p class="result-positive">Login successful! Redirecting...</p>', {
      status: 303, // See Other, appropriate for redirect after POST
      headers: headers,
    })
  } catch (error) {
    console.error("Error during 2FA login:", error)
    return new Response('<p class="result-negative">An unexpected error occurred. Please try again.</p>', {
      status: 500,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#message-area",
      },
    })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
