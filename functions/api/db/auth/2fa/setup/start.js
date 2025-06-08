import { authenticator } from "otplib"
import { read2fa, create2fa } from "../../../../../../src/2fa.js"
import { readUser } from "../../../../../../src/users.js"

const APP_NAME = "PuffAuth" // TODO Configure this in a settings file or environment variable

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  try {
    // Step 2: Check Existing 2FA
    const twoFactorStatus = await read2fa(dbClient, user_uuid)

    if (typeof twoFactorStatus === "object" && twoFactorStatus.error) {
      console.error("Error checking 2FA status:", twoFactorStatus.error)
      return new Response(
        '<p class="result-negative">Error: Could not check 2FA status. Please try again later.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    if (twoFactorStatus.is_enabled == true) {
      return new Response(
        '<p class="result-negative">Error: Two-Factor Authentication is already enabled. Please remove the existing setup first if you wish to re-configure it.</p>',
        {
          status: 400,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    // Step 3: Fetch user's username for the label
    const userResult = await readUser(dbClient, user_uuid)
    if (userResult.error || !userResult.user.user_name) {
      console.error("Error fetching user username:", userResult.error)
      return new Response(
        '<p class="result-negative">Error: Could not retrieve user name to setup 2FA.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }
    const userName = userResult.user.user_name

    // Step 4: Create 2FA Setup if not already present
    let new_secret_for_qr = null // Define here to be accessible for QR code generation
    if (!twoFactorStatus.secret_value) {
      const label = `${APP_NAME}: ${userName}`

      // Step 4a: Generate TOTP Secret
      new_secret_for_qr = authenticator.generateSecret() // Generates a base32 secret

      // Step 4b: "Simulated" Encryption (as per original logic, consider actual encryption for production)
      const encrypted_secret = `sim_encrypted::${new_secret_for_qr}`

      // Step 4c: Store Secret (Unverified) using create2fa
      // create2fa will set is_enabled to FALSE by default
      const createResult = await create2fa(
        dbClient,
        user_uuid,
        encrypted_secret,
        label
      )
      if (createResult.error) {
        console.error("Error storing 2FA secret:", createResult.error)
        return new Response(
          '<p class="result-negative">Error: Failed to save 2FA setup information. Please try again.</p>',
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

    // Step 5: The secret is one of the following:
    // twoFactorStatus.secret_value (if not null and not empty)
    // or the newly generated secret (new_secret_for_qr)
    // Ensure we strip the prefix for the QR code and manual setup display
    let display_secret = twoFactorStatus.secret_value
      ? twoFactorStatus.secret_value.replace("sim_encrypted::", "")
      : new_secret_for_qr
    if (!display_secret) {
      // This case should ideally not be reached if logic is correct
      // but as a fallback if new_secret_for_qr was somehow not set and twoFactorStatus.secret_value was also null/empty
      console.error("Critical error: Secret for QR code generation is missing.")
      return new Response(
        '<p class="result-negative">Error: Failed to generate 2FA setup information due to a missing secret. Please try again.</p>',
        {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        }
      )
    }

    // Step 6: Generate QR Code Data (TOTP Auth URI)
    const otpauthUri = authenticator.keyuri(userName, APP_NAME, display_secret)

    // Step 7: Response - HTML for HTMX
    // TODO: [Security] Consider using a more secure method for generating QR codes
    const htmlResponse = `
      <div>
        <h3>Setup Two-Factor Authentication</h3>
        <p>Scan the QR code with your authenticator app or enter the setup code manually.</p>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 20px; margin-bottom: 1em;">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUri)}" alt="QR Code" style="max-width: 200px; height: auto;"/>
          <div>
            <p><strong>Manual Setup Code:</strong></p>
            <p style="font-family: monospace; background: #f0f0f0; padding: 5px; word-break: break-all;">${display_secret}</p>
          </div>
        </div>
        
        <form id="verify-2fa-form"
              hx-post="/api/db/auth/2fa/setup/verify"
              hx-target="#tfa-message-area" 
              hx-swap="innerHTML">
          <p>After adding to your authenticator app, enter the 6-digit code it provides to verify and enable 2FA.</p>
          <div class="form-group">
            <label for="totp_code_setup">Verification Code:</label>
            <input type="text" id="totp_code_setup" name="totp_code" title="Enter a 6-digit code" required maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" />
          </div>
          <button type="submit" class="btn-save">
            Verify and Enable 2FA
            <img class="htmx-indicator" src="/assets/bars.svg" alt="Loading..."/>
          </button>
        </form>
        <button 
          hx-get="/api/db/auth/2fa/status" 
          hx-target="#tfa-status-container" 
          hx-swap="innerHTML"
          class="btn-danger"
          style="margin-top: 1em;">
          Cancel Setup
        </button>
      </div>
    `

    return new Response(htmlResponse, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error during 2FA setup start:", error)
    return new Response(
      '<p class="result-negative">Error: Failed to start 2FA setup due to an unexpected server error.</p>',
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
