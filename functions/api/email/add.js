import { sessionAuthWithCookie } from "../../../src/sessions.js";
import { createEmail } from "../../../src/emails.js"

export async function onRequestPost(context) {
  try {
    const sessionResult = await sessionAuthWithCookie(context);
    if (sessionResult.error) {
      return new Response(`<p class="error">${sessionResult.error}</p>`, {
        status: sessionResult.status || 401,
        headers: { "Content-Type": "text/html" },
      });
    }
    const { user_uuid } = sessionResult;

    const formData = await context.request.formData()
    const email_address = formData.get("email_address")

    if (
      !email_address ||
      typeof email_address !== "string" ||
      !email_address.includes("@")
    ) {
      return new Response(
        "<p class=\"error\">Email address is missing or invalid.</p>",
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await createEmail(
      context,
      user_uuid,
      email_address,
      false, // is_primary
      false // is_verified
    )

    if (result.error) {
      return new Response(`<p class=\"error\">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    return new Response(
      `<p class=\"success\">Email added. A verification link has been sent (if configured).</p>`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "emailListChanged", // Trigger list refresh
        },
      }
    )
  } catch (error) {
    console.error("Error in add email endpoint:", error)
    let errorMessage = "Failed to add email due to a server error."
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
