import { deleteEmail } from "../../../../../src/emails.js"

export async function onRequestPost(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid
  try {

    const formData = await context.request.formData()
    const email_address_to_remove = formData.get("email_address")

    if (
      !email_address_to_remove ||
      typeof email_address_to_remove !== "string" ||
      !email_address_to_remove.includes("@")
    ) {
      return new Response(
        `<p class="result-negative">Email address is missing or invalid. You submitted "${email_address_to_remove}".</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await deleteEmail(
      dbClient,
      user_uuid,
      email_address_to_remove
    )

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
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
