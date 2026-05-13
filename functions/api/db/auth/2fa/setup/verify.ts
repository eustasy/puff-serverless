import { verify } from "otplib"
import { enable2fa, read2fa } from "../../../../../../src/2fa.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

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
    const secretResult = await read2fa(dbClient, user_uuid)
    if (secretResult.error) {
      console.error("Error reading 2FA secret:", secretResult.message)
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

    if (!secretResult.success) {
      // No 2FA record — user hasn't started setup yet.
      return new Response(
        '<p class="result-negative">Error: 2FA setup has not been started. Please start setup first.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    const secretRecord = secretResult.twoFactor

    if (secretRecord.is_enabled === true) {
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
    const verifyResult = await verify({
      token: totp_code,
      secret: storedSecret,
    })

    if (verifyResult.valid) {
      // Step 5: On Successful Verification, enable 2FA in 'secrets' table
      const enable2faResult = await enable2fa(dbClient, user_uuid)
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
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
