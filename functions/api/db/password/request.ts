import { readEmail } from "../../../../src/emails.js"
import { createPasswordToken } from "../../../../src/tokens.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient

  // Step 1: Parse form data for email
  let formData
  let email
  try {
    formData = await context.request.formData()
    email = formData.get("email")
  } catch (e) {
    return new Response(
      '<p class="result-negative">Invalid request. Please provide an email.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  // Step 2: Input Validation
  if (!email || typeof email !== "string" || !email.includes("@")) {
    // Still return a generic message, but log the specific error
    console.warn("Password reset request with invalid email format.")
    return new Response(
      '<p class="result-positive">If an account exists for the provided email, a password reset link has been sent.</p>',
      { status: 200, headers: { "Content-Type": "text/html" } }
    )
  }

  const genericSuccessResponse = new Response(
    '<p class="result-positive">If an account exists for this email, a password reset link has been sent.</p>',
    { status: 200, headers: { "Content-Type": "text/html" } }
  )

  try {
    // Step 3: User Lookup
    const user = await readEmail(dbClient, email)
    if (!user || !user.email || !user.email.user_uuid) {
      // If no user found, return generic success to avoid leaking info
      console.log(`Password reset requested for non-existent email: ${email}`)
      return genericSuccessResponse
    }

    if (user && user.email.user_uuid) {
      // Step 4: Store Token using createPasswordToken
      const tokenResult = await createPasswordToken(
        dbClient,
        user.email.user_uuid,
        email
      )

      if (tokenResult.error || !tokenResult.token_value) {
        console.error(
          "Failed to create password reset token:",
          tokenResult.message
        )
        // Still return generic success to avoid leaking info, but log the error.
        return genericSuccessResponse
      }
      const token_value = tokenResult.token_value

      // Step 5: Email Sending (Simulated)
      // SECURITY: remove before production — leaks password-reset token into Cloudflare logs
      console.log(
        `Password reset link for ${email}: /reset/set?token=${token_value}`
      )
    } else {
      // Email not found or user_uuid missing, log this internally
      console.log(
        `Password reset requested for non-existent or unlinked email: ${email}`
      )
    }

    // Step 6: Response (Always generic)
    return genericSuccessResponse
  } catch (error) {
    console.error("Error during password reset request:", error)
    // Return HTML error response
    return new Response(
      '<p class="result-negative">An unexpected error occurred. Please try again.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
