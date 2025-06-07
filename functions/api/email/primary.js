import { sessionAuthWithCookie } from "../../../src/sessions.js"
import { setPrimaryEmail } from "../../../src/emails.js"

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
    const new_primary_email_address = formData.get("email_address")

    if (
      !new_primary_email_address ||
      typeof new_primary_email_address !== "string" ||
      !new_primary_email_address.includes("@")
    ) {
      return new Response(
        `<p class="result-negative">New primary email address is missing or invalid. You submitted "${new_primary_email_address}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await setPrimaryEmail(
      context,
      user_uuid,
      new_primary_email_address
    )

    if (result.error) {
      return new Response(`<p class=\"error\">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    // On success, return a success message and trigger an event for HTMX to refresh the list
    return new Response(`<p class=\"success\">${result.message}</p>`, {
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
    return new Response(`<p class=\"error\">${errorMessage}</p>`, {
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
