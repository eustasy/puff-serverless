import { verifySession } from "../../../src/session_auth.js";
import { removeEmail } from "../../../src/emails.js";

export async function onRequestPost(context) {

  let user_uuid
  try {
    const tempClient = new Client(context.env.HYPERDRIVE.connectionString)
    await tempClient.connect()
    // Session token from form data as per previous structure
    const formData = await context.request.formData()
    const sessionToken = formData.get("session_token")
    const emailToRemove = formData.get("email_address")

    if (!sessionToken || !emailToRemove) {
      await tempClient.end()
      return new Response(
        JSON.stringify({ error: "Session token and email address are required." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const sessionResult = await verifySession(tempClient, sessionToken)
    await tempClient.end()

    if (sessionResult.error) {
      return new Response(JSON.stringify({ error: sessionResult.error }), {
        status: sessionResult.status || 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    user_uuid = sessionResult.user_uuid

    // Call the centralized removeEmail function
    const result = await removeEmail(context, user_uuid, emailToRemove)

    if (result.error) {
      return new Response(JSON.stringify({ error: result.message }), {
        status: result.status || 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ message: result.message }), {
      status: result.status || 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Error in remove email endpoint:", error)
    // Check if it's a form data parsing error or other type of error
    if (error instanceof TypeError && error.message.includes("formData")) {
      return new Response(
        JSON.stringify({ error: "Invalid request format. Expected form data." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    return new Response(
      JSON.stringify({ error: "Failed to remove email due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  })
}
