import { has2fa } from "../../../src/2fa.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  // Step 2: Use has2fa to check the 2FA status.
  const twoFactorStatus = await has2fa(dbClient, user_uuid)

  if (twoFactorStatus.error) {
    console.error("Error checking 2FA status:", twoFactorStatus.message)
    return new Response("<p>Error: Could not retrieve 2FA status. Please try again later.</p>", {
      status: 500, // Internal Server Error
      headers: {
        "Content-Type": "text/html",
        "HX-Retarget": "#tfa-message-area",
      },
    })
  }

  let htmlResponse

  if (twoFactorStatus.enabled) {
    htmlResponse = `
      <p>Two-Factor Authentication is currently <strong class="result-positive">enabled</strong>.</p>
      <form hx-post="/api/2fa/remove" hx-target="#tfa-message-area" hx-swap="innerHTML">
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
    // The /api/2fa/remove endpoint should return HX-Trigger: tfaStatusChanged on success
    // to refresh this #tfa-status-container.
  } else {
    htmlResponse = `
      <p>Two-Factor Authentication is currently <strong class="result-negative">disabled</strong>.</p>
      <button
        class="btn-save"
        hx-post="/api/2fa/setup/start"
        hx-target="#tfa-status-container"
        hx-swap="innerHTML"
        hx-trigger="click"
        hx-disabled-elt="this"
      >
        Setup 2FA
        <img class="htmx-indicator" src="/assets/bars.svg" alt="Loading..."/>
      </button>
    `
    // The /api/2fa/setup/start endpoint would typically replace the content of
    // #tfa-status-container with the 2FA setup UI (e.g., QR code, code input).
    // Upon successful setup, the final step of enabling 2FA should trigger the
    // 'tfaStatusChanged' event (e.g. via HX-Trigger header) to refresh this container.
  }

  return new Response(htmlResponse, {
    headers: { "Content-Type": "text/html" },
  })
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
