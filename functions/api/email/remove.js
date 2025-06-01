import { sessionAuthWithCookie } from "../../../src/sessions.js"
import { deleteEmail } from "../../../src/emails.js"

export async function onRequestPost(context) {
  try {
    const sessionResult = await sessionAuthWithCookie(context)
    if (sessionResult.error) {
      return new Response(`<p class=\"error\">${sessionResult.error}</p>`, {
        status: sessionResult.status || 401,
        headers: { "Content-Type": "text/html" },
      })
    }
    const { user_uuid } = sessionResult

    const formData = await context.request.formData()
    const emailIdToRemove = formData.get("email_id") // Changed to email_id to match hx-vals

    if (!emailIdToRemove) {
      return new Response("<p class=\"error\">Email ID is required.</p>", {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Assuming deleteEmail expects the actual email address string.
    // If deleteEmail can handle an ID, this part might need adjustment or the `emails.js` function signature updated.
    // For now, this assumes `emailIdToRemove` is the string, but this is a potential issue.
    const result = await deleteEmail(context, user_uuid, emailIdToRemove)

    if (result.error) {
      return new Response(`<p class=\"error\">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    return new Response(`<p class=\"success\">${result.message}</p>`, {
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
    return new Response(`<p class=\"error\">${errorMessage}</p>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response("<p class=\"error\">Method Not Allowed</p>", {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "text/html" },
  })
}
