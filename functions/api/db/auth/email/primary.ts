import { setPrimaryEmail } from "../../../../../src/emails.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { emitFromContext } from "../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!
  try {
    const formData = await context.request.formData()
    const new_primary_email_address = formData.get("email_address")

    if (!new_primary_email_address || typeof new_primary_email_address !== "string" || !new_primary_email_address.includes("@")) {
      return new Response(
        `<p class="result-negative">New primary email address is missing or invalid. You submitted "${escapeHtml(new_primary_email_address)}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await setPrimaryEmail(dbClient, user_uuid, new_primary_email_address)

    if (result.error) {
      return new Response(`<p class=\"result-negative\">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_EMAIL_SET_PRIMARY,
      target_user_uuid: user_uuid,
      target_label: new_primary_email_address,
    })

    // On success, return a success message and trigger an event for HTMX to refresh the list
    return new Response(`<p class=\"result-positive\">${result.message}</p>`, {
      status: result.status || 200,
      headers: {
        "Content-Type": "text/html",
        "HX-Trigger": "emailListChanged",
      },
    })
  } catch (error) {
    console.error("Error in set primary email endpoint:", error)
    let errorMessage = "Failed to change primary email due to a server error."
    if (error instanceof TypeError && error.message.includes("formData")) {
      errorMessage = "Invalid request format. Expected form data."
    }
    return new Response(`<p class=\"result-negative\">${errorMessage}</p>`, {
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
