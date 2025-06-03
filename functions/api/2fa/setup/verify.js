import { sessionAuthWithCookie } from "../../../../src/sessions.js"
import { authenticator } from "otplib"
import { enable2fa, read2fa } from "../../../../src/2fa.js"

export async function onRequestPost(context) {
  // Step 1: Verify the session
  const sessionResult = await sessionAuthWithCookie(context)
  if (sessionResult.error) {
    return new Response(
      `<p class="result-negative">Error: ${sessionResult.error} Please log in.</p>`,
      {
        status: sessionResult.status || 401,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      }
    )
  }
  const user_uuid = sessionResult

  // Step 2: Parse form data for TOTP code
  let formData
  try {
    formData = await context.request.formData()
  } catch (e) {
    return new Response(
      '<p class="result-negative">Error: Invalid request body. Expected form data.</p>',
      {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      }
    )
  }

  const totp_code = formData.get("totp_code")
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      '<p class="result-negative">Error: TOTP code is missing or invalid.</p>',
      {
        status: 400,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      }
    )
  }

  try {
    // Step 3: Retrieve Stored Secret from 'secrets' table
    const read2faResult = await read2fa(context, user_uuid)
    if (read2faResult.error) {
      console.error("Error reading 2FA secret:", read2faResult.error)
      return new Response(
        '<p class="result-negative">Error: Could not retrieve 2FA secret. Please try again later.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    if (read2faResult.is_enabled === true) {
      return new Response(
        '<p class="result-positive">2FA is already verified and enabled.</p>',
        {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
            "HX-Trigger": "tfaStatusChanged",
          },
        }
      )
    }

    // "Decrypt" the secret_value
    if (!secretRecord.secret_value.startsWith("sim_encrypted::")) {
      console.error(
        `Invalid secret_value format for user ${user_uuid} of type \'totp_secret\'.`
      )
      return new Response(
        '<p class="result-negative">Error: Internal error with 2FA secret storage.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }
    const storedSecret = secretRecord.secret_value.replace(
      "sim_encrypted::",
      ""
    )

    // Step 4: Verify TOTP Code
    const isValid = authenticator.check(totp_code, storedSecret)

    if (isValid) {
      // Step 5: On Successful Verification, enable 2FA in 'secrets' table
      const enable2faResult = await enable2fa(context, user_uuid)
      if (enable2faResult.error) {
        console.error("Error enabling 2FA:", enable2faResult.error)
        return new Response(
          '<p class="result-negative">Error: Failed to enable 2FA due to a server error.</p>',
          {
            status: 500,
            headers: {
              "Content-Type": "text/html",
              "HX-Retarget": "#tfa-message-area",
            },
          }
        )
      }

      return new Response(
        '<p class="result-positive">2FA setup successful and enabled.</p>',
        {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
            "HX-Trigger": "tfaStatusChanged",
          },
        }
      )
    } else {
      // Step 6: On Failed Verification
      return new Response(
        '<p class="result-negative">Error: Invalid TOTP code. Please try again.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }
  } catch (error) {
    console.error("Error during 2FA verification:", error)
    return new Response(
      '<p class="result-negative">Error: Failed to verify 2FA setup due to a server error.</p>',
      {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      }
    )
  } finally {
    if (client) {
      await client.end()
    }
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response(
    '<p class="result-negative">Error: Method Not Allowed. Only POST requests are accepted for this action.</p>',
    {
      status: 405,
      headers: {
        "Allow": "POST",
        "Content-Type": "text/html",
        "HX-Retarget": "#tfa-message-area", // Retarget even for method not allowed
      },
    }
  )
}
