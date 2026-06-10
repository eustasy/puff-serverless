import { createEmail } from "../../../src/emails.js"
import { escapeHtml } from "../../../src/utilities/escape.js"
import { emitFromContext } from "../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  try {
    const formData = await context.request.formData()
    const email_address = formData.get("email_address")

    // The email address comes from the form field only. (The previous prompt-header
    // fallback was dropped: HTMX 4 removed the browser-prompt attribute, so the
    // add-email control is now a real <input name="email_address"> form.)
    if (typeof email_address !== "string") {
      return new Response('<p class="result-negative">Email address is missing or submitted in an invalid format.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Now we know email_address is a string.
    const trimmed_email_address = email_address.trim()

    if (trimmed_email_address === "" || !trimmed_email_address.includes("@")) {
      return new Response(
        `<p class="result-negative">Email address is invalid. It must contain an "@" symbol. You submitted "${escapeHtml(trimmed_email_address)}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await createEmail(
      dbClient,
      user_uuid,
      trimmed_email_address, // Use the potentially corrected and trimmed email
      false, // is_primary
      false // is_verified
    )

    if (result.error) {
      return new Response(`<p class="result-negative">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_EMAIL_ADDED,
      target_user_uuid: user_uuid,
      target_label: trimmed_email_address,
    })

    return new Response(`<p class="result-positive">Email added. A verification link has been sent (if configured).</p>`, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "HX-Trigger": "emailListChanged", // Trigger list refresh
      },
    })
  } catch (error) {
    console.error("Error in add email endpoint:", error)
    let errorMessage = "Failed to add email due to a server error."
    if (error instanceof TypeError && error.message.includes("formData")) {
      errorMessage = "Invalid request format. Expected form data."
    }
    return new Response(`<p class="result-negative">${errorMessage}</p>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
