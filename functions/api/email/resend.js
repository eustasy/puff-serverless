import { sessionAuthWithCookie } from "../../../src/sessions.js"
import { createEmailToken, readToken } from "../../../src/tokens.js"
import { readEmail } from "../../../src/emails.js"

export async function onRequestPost(context) {
  try {
    const sessionResult = await sessionAuthWithCookie(context)
    if (sessionResult.error) {
      return new Response(
        `<p class="result-negative">${sessionResult.error}</p>`,
        {
          status: sessionResult.status || 401,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    const user_uuid = sessionResult

    const formData = await context.request.formData()
    const email_address = formData.get("email_address")

    if (
      !email_address ||
      typeof email_address !== "string" ||
      !email_address.includes("@")
    ) {
      return new Response(
        `<p class="result-negative">Email address is missing or invalid. You submitted "${email_address}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const emailRecordResult = await readEmail(context, email_address)

    if (
      emailRecordResult.error ||
      !emailRecordResult.success ||
      !emailRecordResult.email
    ) {
      console.error(
        "Error reading email for user:",
        emailRecordResult
          ? emailRecordResult.message
          : "No email record returned"
      )
      let userMessage =
        "Could not retrieve your email address. Please try again."
      if (
        emailRecordResult &&
        emailRecordResult.message === "Email not found."
      ) {
        userMessage = `Email address "${email_address}" not found for your account.`
      }
      return new Response(`<p class="result-negative">${userMessage}</p>`, {
        // Use 404 if email not found, otherwise 500
        status:
          emailRecordResult && emailRecordResult.message === "Email not found."
            ? 404
            : 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    const emailToVerify = emailRecordResult.email

    // Check if the found email belongs to the authenticated user
    if (emailToVerify.user_uuid !== user_uuid) {
      console.error(
        `User ${user_uuid} attempted to resend verification for email ${email_address} belonging to ${emailToVerify.user_uuid}`
      )
      return new Response(
        `<p class="result-negative">Email address "${email_address}" not found for your account.</p>`,
        {
          status: 404,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    // Check if the email is already verified
    if (emailToVerify.is_verified) {
      return new Response(
        `<p class="result-info">This email address is already verified.</p>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    // If the email is not verified, proceed to create a new token.
    // The previous logic to read an existing token using emailToVerify.token_value was flawed
    // as emails table doesn't store token_value directly.
    // A user requesting to resend implies they need a new (or resent) token.
    const tokenResult = await createEmailToken(
      context,
      user_uuid,
      email_address
    )

    if (tokenResult.error) {
      console.error("Failed to create verification token:", tokenResult.message)
      return new Response(
        `<p class="result-negative">Failed to generate new verification token: ${tokenResult.message}</p>`,
        {
          status: tokenResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    return new Response(
      `<p class="result-positive">New verification token generated: ${tokenResult.token_value}.</p>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "emailListChanged",
        },
      }
    )
  } catch (error) {
    console.error("Error in /api/email/resend endpoint:", error)
    let errorMessage = "Failed to resend verification due to a server error."
    if (error instanceof TypeError && error.message.includes("formData")) {
      errorMessage = "Invalid request format. Expected form data."
    }
    return new Response(`<p class="result-negative">${errorMessage}</p>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response('<p class="result-negative">Method Not Allowed</p>', {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "text/html" },
  })
}
