import { sessionAuthWithCookie } from "../../../src/sessions.js"
import {
  password_requirements,
  password_requirements_html,
  password_verify,
  updatePassword, // Import updatePassword
} from "../../../src/passwords.js"
// puff_hashing_password is used by updatePassword internally, so not directly needed here if updatePassword is used.
// However, if we want to keep the structure where hash/salt are generated before calling update,
// then updatePassword might need to be adjusted or we use a different helper.
// For now, assuming updatePassword takes the new plain password.

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
  // context.data.user_uuid is populated by sessionAuthWithCookie if successful and it modifies context.data
  // If sessionAuthWithCookie only returns user_uuid, we might need to set it:
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

  const { current_password, new_password } = requestBody

  // Step 3: Input Validation
  if (!current_password || typeof current_password !== "string") {
    return new Response(
      "<p>Error: Current password is missing or invalid.</p>",
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response("<p>Error: New password is missing or invalid.</p>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  try {
    // Step 4: Password Strength Check (New Password)
    const isPasswordStrong = await password_requirements(new_password)
    if (!isPasswordStrong) {
      const requirementsHtml = await password_requirements_html(new_password)
      return new Response(
        `<div>
           <p>Error: New password does not meet requirements.</p>
           ${requirementsHtml}
         </div>`,
        { status: 400, headers: { "Content-Type": "text/html" } }
      )
    }

    // Step 5: Verify Current Password
    // password_verify handles its own DB connection via context
    const currentPasswordMatches = await password_verify(
      context,
      current_password,
      user_uuid
    )

    if (!currentPasswordMatches) {
      return new Response("<p>Error: Incorrect current password.</p>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Step 6: Update Password using the helper function
    const passwordUpdated = await updatePassword(
      context,
      user_uuid,
      new_password
    )

    if (!passwordUpdated) {
      // This might indicate the user record wasn't found for update, or a DB error occurred within updatePassword
      console.error(
        `Failed to update password for user_uuid (updatePassword returned false): ${user_uuid}`
      )
      return new Response(
        "<p>Error: Failed to update password. The user record might not exist or an internal error occurred.</p>",
        { status: 500, headers: { "Content-Type": "text/html" } }
      )
    }

    // Step 7: Response
    // For HTMX, a redirect to a profile page or a success message might be appropriate.
    // Example: Redirect to /profile with a success message query parameter
    // Or, return a partial HTML to update a section of the page.
    // For now, a simple success message.
    return new Response(
      "<p>Password changed successfully.</p>", // Consider an HX-Redirect if applicable
      { status: 200, headers: { "Content-Type": "text/html" } }
    )
  } catch (error) {
    // This catch block will now primarily catch errors from password_verify or updatePassword if they throw,
    // or issues with sessionAuthWithCookie if it throws instead of returning a Response.
    console.error("Error during password change:", error)
    return new Response(
      "<p>Error: Failed to change password due to a server error.</p>",
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
  // No finally block needed here as individual helpers manage their own DB connections.
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context)
  }
  return new Response(
    "<p>Error: Method Not Allowed. Only POST requests are accepted.</p>",
    {
      status: 405,
      headers: { "Allow": "POST", "Content-Type": "text/html" },
    }
  )
}
