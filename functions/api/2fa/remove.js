import { sessionAuthWithCookie } from "../../../src/sessions.js"
import { read2fa, delete2fa } from "../../../src/2fa.js" // Import read2fa and delete2fa
import { authenticator } from "otplib"

export async function onRequestPost(context) {
  // Step 1: Session Verification
  const user_uuid = await sessionAuthWithCookie(context)
  if (!user_uuid || typeof user_uuid !== "string") {
    if (user_uuid instanceof Response) return user_uuid
    return new Response(
      "<p>Session invalid or expired. Please log in again.</p>",
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  // Ensure context.data.user_uuid is available if other parts rely on it
  if (!context.data) context.data = {}
  context.data.user_uuid = user_uuid

  // Step 2: Parse JSON body
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response("<p>Error: Invalid JSON body.</p>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  const { totp_code } = requestBody

  // Step 3: Input Validation
  if (
    !totp_code ||
    typeof totp_code !== "string" ||
    !/^\d{6}$/.test(totp_code)
  ) {
    return new Response(
      "<p>Error: TOTP code is missing or invalid. It must be a 6-digit number.</p>",
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  try {
    // Step 4: Check if 2FA is Enabled and retrieve secret
    // read2fa handles its own DB connection via context
    const secretRecord = await read2fa(context, user_uuid)

    if (secretRecord && secretRecord.error) {
      console.error("Error reading 2FA secret for removal:", secretRecord.error)
      return new Response(
        "<p>Error: Could not retrieve 2FA status due to a server error.</p>",
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }

    if (!secretRecord || !secretRecord.is_enabled) {
      // Check is_enabled flag
      return new Response(
        "<p>Error: 2FA is not currently enabled for this account.</p>",
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

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
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }

    const isValid = authenticator.check(totp_code, storedSecret)

    if (!isValid) {
      return new Response("<p>Error: Invalid TOTP code.</p>", {
        status: 400, // Or 401/403 depending on exact security stance
        headers: { "Content-Type": "text/html" },
      })
    }

    // Step 6: Remove 2FA Configuration using the helper function
    // delete2fa handles its own DB connection via context
    const deletionResult = await delete2fa(context, user_uuid)

    if (deletionResult.error) {
      console.error("Error during 2FA secret deletion:", deletionResult.error)
      return new Response(
        "<p>Error: Failed to remove 2FA due to a server error during deletion.</p>",
        {
          status: deletionResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    if (deletionResult.rowCount === 0) {
      // This case implies the record was already gone, which is fine for a removal operation.
      console.warn(
        `Attempted to delete 2FA record for user ${user_uuid}, but no record was found or deleted (rowCount: 0).`
      )
    }

    // Step 7: Response
    // For HTMX, this might redirect to a settings page or update the UI to show 2FA is disabled.
    return new Response(
      "<p>Two-factor authentication has been removed successfully.</p>",
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          // Consider HX-Redirect or HX-Trigger if the UI needs to update significantly
          // "HX-Redirect": "/account/settings"
        },
      }
    )
  } catch (error) {
    // This catch block is for unexpected errors not handled by the helper functions' error returns.
    console.error("Unexpected error during 2FA removal:", error)
    return new Response(
      "<p>Error: Failed to remove 2FA due to an unexpected server error.</p>",
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  // Return HTML for Method Not Allowed
  return new Response(
    "<p>Error: Method Not Allowed. Only POST requests are accepted for this action.</p>",
    {
      status: 405,
      headers: { "Allow": "POST", "Content-Type": "text/html" },
    }
  )
}
