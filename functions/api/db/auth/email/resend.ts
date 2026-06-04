import { createEmailToken } from "../../../../../src/tokens.js"
import { readEmail } from "../../../../../src/emails.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { sendVerificationEmail } from "../../../../../src/mailer.js"
import { emitFromContext } from "../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  try {
    const formData = await context.request.formData()
    const email_address = formData.get("email_address")

    if (!email_address || typeof email_address !== "string" || !email_address.includes("@")) {
      return new Response(
        `<p class="result-negative">Email address is missing or invalid. You submitted "${escapeHtml(email_address)}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const emailRecordResult = await readEmail(dbClient, email_address)

    if (emailRecordResult.error) {
      console.error("Error reading email for user:", emailRecordResult.message)
      return new Response(`<p class="result-negative">Could not retrieve your email address. Please try again.</p>`, {
        status: 500,
        headers: { "Content-Type": "text/html" },
      })
    }
    if (!emailRecordResult.success) {
      return new Response(`<p class="result-negative">Email address "${escapeHtml(email_address)}" not found for your account.</p>`, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })
    }

    const emailToVerify = emailRecordResult.email

    // Check if the found email belongs to the authenticated user
    if (emailToVerify.user_uuid !== user_uuid) {
      console.error(`User ${user_uuid} attempted to resend verification for email ${email_address} belonging to ${emailToVerify.user_uuid}`)
      return new Response(`<p class="result-negative">Email address "${escapeHtml(email_address)}" not found for your account.</p>`, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Check if the email is already verified
    if (emailToVerify.is_verified) {
      return new Response(`<p class="result-info">This email address is already verified.</p>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Reuse an existing valid token if one exists — avoids accumulating unused
    // tokens on repeated resend clicks and keeps the old link working.
    const existingTokenResult = await dbClient.query(
      "SELECT token_value FROM tokens WHERE user_uuid = $1 AND token_type = 'email_verification' AND email_address = $2 AND is_used = FALSE AND expires_at > NOW() ORDER BY expires_at DESC LIMIT 1",
      [user_uuid, email_address]
    )

    let token_value: string
    if (existingTokenResult.rows.length > 0) {
      token_value = existingTokenResult.rows[0].token_value
    } else {
      const tokenResult = await createEmailToken(dbClient, user_uuid, email_address)
      if (tokenResult.error) {
        console.error("Failed to create verification token:", tokenResult.message)
        return new Response(`<p class="result-negative">Failed to generate verification token. Please try again.</p>`, {
          status: 500,
          headers: { "Content-Type": "text/html" },
        })
      }
      token_value = tokenResult.token_value
    }

    // Deliver the token out-of-band (email). The user explicitly asked to
    // resend, so a delivery failure is reported back rather than swallowed.
    const mailResult = await sendVerificationEmail(context.env, email_address, token_value)
    if (mailResult.error) {
      console.error("Failed to send verification email on resend:", mailResult.message)
      return new Response(`<p class="result-negative">Could not send the verification email right now. Please try again shortly.</p>`, {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_EMAIL_VERIFICATION_RESENT,
      target_user_uuid: user_uuid,
      target_label: email_address,
    })

    return new Response(`<p class="result-positive">A new verification link has been sent to ${escapeHtml(email_address)}.</p>`, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "HX-Trigger": "emailListChanged",
      },
    })
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

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
