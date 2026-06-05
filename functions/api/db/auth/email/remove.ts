import { deleteEmail } from "../../../../../src/emails.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { emitFromContext } from "../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!
  try {
    const formData = await context.request.formData()
    const email_address_to_remove = formData.get("email_address")

    if (!email_address_to_remove || typeof email_address_to_remove !== "string" || !email_address_to_remove.includes("@")) {
      return new Response(
        `<p class="result-negative">Email address is missing or invalid. You submitted "${escapeHtml(email_address_to_remove)}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await deleteEmail(dbClient, user_uuid, email_address_to_remove)

    if (result.error) {
      return new Response(`<p class="result-negative">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_EMAIL_REMOVED,
      target_user_uuid: user_uuid,
      target_label: email_address_to_remove,
    })

    return new Response(`<p class="result-positive">${result.message}</p>`, {
      status: result.status || 200,
      headers: {
        "Content-Type": "text/html",
        "HX-Trigger": "emailListChanged",
      },
    })
  } catch (error) {
    console.error("Error in remove email endpoint:", error)
    let errorMessage = "Failed to remove email due to a server error."
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
