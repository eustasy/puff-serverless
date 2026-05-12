import { has2fa } from "../../../../../src/2fa.js"

export async function onRequestGet(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  // Step 2: Use has2fa to check the 2FA status.
  const twoFactorStatus = await has2fa(dbClient, user_uuid)

  let is2FAEnabled
  if (typeof twoFactorStatus === "object" && twoFactorStatus.error) {
    // Handle error from has2fa (e.g., database issue)
    console.error("Error checking 2FA status:", twoFactorStatus.error)
    return new Response(
      "<p>Error: Could not retrieve 2FA status. Please try again later.</p>",
      {
        status: 500, // Internal Server Error
        headers: {
          "Content-Type": "text/html",
          "HX-Retarget": "#tfa-message-area",
        },
      }
    )
  } else {
    is2FAEnabled = twoFactorStatus
  }

  let htmlResponse

  if (is2FAEnabled) {
    htmlResponse = `
      <p>Two-Factor Authentication is currently <strong class="result-positive">enabled</strong>.</p>
      <form hx-post="/api/db/auth/2fa/remove" hx-target="#tfa-message-area" hx-swap="innerHTML">
        <div class="spacer-bottom">
          <label for="totp_code">Enter your 6-digit authenticator code to remove 2FA:</label>
          <input 
            type="text" 
            id="totp_code" 
            name="totp_code" 
            placeholder="123456" 
            pattern="[0-9]{6}" 
            autocomplete="one-time-code"
            maxlength="6" 
            required
          />
        </div>
        <button
          type="submit"
          class="btn-danger"
          hx-disabled-elt="this"
          hx-confirm="Are you sure you want to remove Two-Factor Authentication? This will reduce your account security."
        >
          Remove 2FA
          <img class="htmx-indicator" src="/assets/bars.svg" alt="Loading..."/>
        </button>
      </form>
    `
    // The /api/db/auth/2fa/remove endpoint should return HX-Trigger: tfaStatusChanged on success
    // to refresh this #tfa-status-container.
  } else {
    htmlResponse = `
      <p>Two-Factor Authentication is currently <strong class="result-negative">disabled</strong>.</p>
      <button
        class="btn-save"
        hx-post="/api/db/auth/2fa/setup/start"
        hx-target="#tfa-status-container"
        hx-swap="innerHTML"
        hx-trigger="click"
        hx-disabled-elt="this"
      >
        Setup 2FA
        <img class="htmx-indicator" src="/assets/bars.svg" alt="Loading..."/>
      </button>
    `
    // The /api/db/auth/2fa/setup/start endpoint would typically replace the content of
    // #tfa-status-container with the 2FA setup UI (e.g., QR code, code input).
    // Upon successful setup, the final step of enabling 2FA should trigger the
    // 'tfaStatusChanged' event (e.g. via HX-Trigger header) to refresh this container.
  }

  return new Response(htmlResponse, {
    headers: { "Content-Type": "text/html" },
  })
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
