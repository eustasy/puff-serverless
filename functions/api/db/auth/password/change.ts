import {
  password_requirements,
  password_requirements_html,
  password_verify,
  updatePassword,
} from "../../../../../src/passwords.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  // Step 2: Parse Form Data
  let current_password, new_password
  try {
    const formData = await context.request.formData()
    current_password = formData.get("current_password")
    new_password = formData.get("pw")
  } catch (e) {
    return new Response("<p>Error: Invalid form data.</p>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

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
    const isPasswordStrong = password_requirements(new_password)
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
    const verifyResult = await password_verify(
      dbClient,
      user_uuid,
      current_password
    )

    if (verifyResult.error) {
      console.error("Error verifying current password:", verifyResult.message)
      return new Response(
        `<p>Error: ${verifyResult.message || "Could not verify current password."}</p>`,
        {
          status: verifyResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    if (!verifyResult.verified) {
      return new Response("<p>Error: Incorrect current password.</p>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Step 6: Update Password using the helper function
    const updateResult = await updatePassword(dbClient, user_uuid, new_password)

    if (updateResult.error || !updateResult.success) {
      console.error(
        `Failed to update password for user_uuid ${user_uuid}: ${updateResult.message}`
      )
      return new Response(
        `<p>Error: ${updateResult.message || "Failed to update password."}</p>`,
        {
          status: updateResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    // Step 7: Response
    return new Response(
      "<p>Password changed successfully.</p>", // Consider an HX-Redirect if applicable
      { status: 200, headers: { "Content-Type": "text/html" } }
    )
  } catch (error) {
    // None of the src/ helpers used here throw — this catches only
    // unexpected runtime errors (e.g., formData parsing).
    console.error("Error during password change:", error)
    return new Response(
      "<p>Error: Failed to change password due to a server error.</p>",
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
  // No finally block needed here as individual helpers manage their own DB connections.
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
