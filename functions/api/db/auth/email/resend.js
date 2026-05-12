import { createEmailToken, readToken } from "../../../../../src/tokens.js" // TODO use readToken to check if a token already exists
import { readEmail } from "../../../../../src/emails.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  try {
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

    const emailRecordResult = await readEmail(dbClient, email_address)

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
      dbClient,
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

    // SECURITY: the token must be delivered out-of-band (email).
    // Never include tokenResult.token_value in the response body.
    // TODO Wait for email messaging to be implemented; log link until then.
    console.log(
      `Verification link: /api/db/email/verify?token=${tokenResult.token_value}`
    )

    return new Response(
      `<p class="result-positive">A new verification link has been sent to ${email_address}.</p>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "emailListChanged",
        },
      }
    )
  } catch (error) {
    console.error("Error in /api/db/auth/email/resend endpoint:", error)
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
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
