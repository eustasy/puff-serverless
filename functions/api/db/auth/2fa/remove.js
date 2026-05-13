import { verify } from "otplib"
import { read2fa, delete2fa } from "../../../../../src/2fa.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  // Step 2: Parse form data
  let formData
  try {
    formData = await context.request.formData()
  } catch (e) {
    return new Response("<p>Error: Invalid form data.</p>", {
      status: 400,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#tfa-message-area",
      },
    })
  }

  const totp_code = formData.get("totp_code")

  // Step 3: Input Validation
  if (
    !totp_code ||
    typeof totp_code !== "string" ||
    !/^\d{6}$/.test(totp_code)
  ) {
    return new Response(
      "<p>Error: TOTP code is missing or invalid. It must be a 6-digit number.</p>",
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
    // Step 4: Check if 2FA is Enabled and retrieve secret
    const secretResult = await read2fa(dbClient, user_uuid)

    if (secretResult.error) {
      console.error(
        "Error reading 2FA secret for removal:",
        secretResult.message
      )
      return new Response(
        "<p>Error: Could not retrieve 2FA status due to a server error.</p>",
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    if (!secretResult.success || !secretResult.twoFactor.is_enabled) {
      return new Response(
        "<p>Error: 2FA is not currently enabled for this account.</p>",
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

    // Step 5: Verify TOTP Code
    // Assuming secret_value is stored directly (not encrypted in this example based on original code's direct use)
    // If it were encrypted, decryption would happen here or in read2fa.
    // The original code had a "sim_encrypted::" prefix, which is handled here for now.
    let storedSecret = secretRecord.secret_value
    if (storedSecret && storedSecret.startsWith("sim_encrypted::")) {
      storedSecret = storedSecret.replace("sim_encrypted::", "")
    }

    if (!storedSecret) {
      console.error(
        `Missing secret_value for user ${user_uuid} of type 'totp_secret' during 2FA removal, despite being enabled.`
      )
      return new Response(
        "<p>Error: Internal error with 2FA configuration. Secret not found.</p>",
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    const verifyResult = await verify({
      token: totp_code,
      secret: storedSecret,
    })

    if (!verifyResult.valid) {
      return new Response("<p>Error: Invalid TOTP code.</p>", {
        status: 400, // Or 401/403 depending on exact security stance
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      })
    }

    // Step 6: Remove 2FA Configuration using the helper function
    const deletionResult = await delete2fa(dbClient, user_uuid)

    if (deletionResult.error) {
      console.error("Error during 2FA secret deletion:", deletionResult.error)
      return new Response(
        "<p>Error: Could not disable 2FA due to a server error.</p>",
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    // Success
    return new Response(
      '<p class="result-positive">2FA has been successfully removed from your account.</p>',
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
          "HX-Trigger": "tfaStatusChanged",
        },
      }
    )
  } catch (error) {
    console.error("Unexpected error during 2FA removal:", error)
    return new Response(
      "<p>Error: An unexpected error occurred while removing 2FA.</p>",
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

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
