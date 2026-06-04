import { generateSecret, generateURI } from "otplib"
import { renderSVG } from "uqr"
import { read2fa, create2fa } from "../../../../../../src/2fa.js"
import { readUser } from "../../../../../../src/users.js"
import { emitFromContext } from "../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!
  const APP_NAME = context.env.APP_NAME || "PuffAuth"

  try {
    // Step 2: Check Existing 2FA
    // read2fa envelope: { success: true, twoFactor, status } on hit;
    // { success: false, ..., status: 404 } when no 2FA row yet (first-time setup);
    // { error: true, message, details, status: 500 } on DB error.
    const twoFactorStatus = await read2fa(dbClient, user_uuid)
    const twoFactor = twoFactorStatus.success ? twoFactorStatus.twoFactor : null

    if (twoFactorStatus.error) {
      console.error("Error checking 2FA status:", twoFactorStatus.message)
      return new Response('<p class="result-negative">Error: Could not check 2FA status. Please try again later.</p>', {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      })
    }

    if (twoFactor && twoFactor.is_enabled == true) {
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
    if (userResult.error || !userResult.success) {
      console.error("Error fetching user for user_uuid:", user_uuid, userResult.message)
      return new Response('<p class="result-negative">Error: Could not retrieve user name to setup 2FA.</p>', {
        status: 500,
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      })
    }
    const userName = userResult.user.user_name

    // Step 4: Create 2FA Setup if not already present
    let new_secret_for_qr: string | null = null // Define here to be accessible for QR code generation
    if (!twoFactor || !twoFactor.secret_value) {
      const label = `${APP_NAME}: ${userName}`

      // Step 4a: Generate TOTP Secret
      new_secret_for_qr = generateSecret() // Generates a base32 secret

      // Step 4b: "Simulated" Encryption (as per original logic, consider actual encryption for production)
      const encrypted_secret = `sim_encrypted::${new_secret_for_qr}`

      // Step 4c: Store Secret (Unverified) using create2fa
      // create2fa will set is_enabled to FALSE by default
      const createResult = await create2fa(dbClient, user_uuid, encrypted_secret, label)
      if (createResult.error) {
        console.error("Error storing 2FA secret:", createResult.message)
        return new Response('<p class="result-negative">Error: Failed to save 2FA setup information. Please try again.</p>', {
          status: 500,
          headers: {
            "Content-Type": "text/html",
            "HX-Retarget": "#tfa-message-area",
          },
        })
      }
      await emitFromContext(context, {
        event_type: EVENTS.ACCOUNT_2FA_SETUP_STARTED,
        target_user_uuid: user_uuid,
      })
    }

    // Step 5: The secret is one of the following:
    // twoFactor.secret_value (if a row exists with one set)
    // or the newly generated secret (new_secret_for_qr)
    // Ensure we strip the prefix for the QR code and manual setup display
    let display_secret = twoFactor && twoFactor.secret_value ? twoFactor.secret_value.replace("sim_encrypted::", "") : new_secret_for_qr
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

    // Step 6: Generate the TOTP auth URI and render it to a QR code.
    // The URI embeds the TOTP secret, so the QR code is rendered here, in the
    // Worker, as an inline SVG — the secret is never sent to a third-party
    // image service. Inline SVG is page markup, not a fetched resource, so it
    // is also unaffected by the page's `default-src https:` CSP.
    const otpauthUri = generateURI({
      issuer: APP_NAME,
      label: userName,
      secret: display_secret,
    })
    const qrCodeSvg = renderSVG(otpauthUri, { border: 2 }).replace(
      "<svg",
      '<svg class="tfa-qr-code" width="200" height="200" role="img" aria-label="Two-factor authentication QR code"'
    )

    // Step 7: Response - HTML for HTMX
    const htmlResponse = `
      <div>
        <h3>Setup Two-Factor Authentication</h3>
        <p>Scan the QR code with your authenticator app or enter the setup code manually.</p>
        <div class="tfa-qr-layout">
          ${qrCodeSvg}
          <div>
            <p><strong>Manual Setup Code:</strong></p>
            <p class="tfa-secret-display">${display_secret}</p>
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
          class="btn-danger spacer-top">
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
    return new Response('<p class="result-negative">Error: Failed to start 2FA setup due to an unexpected server error.</p>', {
      status: 500,
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#tfa-message-area",
      },
    })
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
