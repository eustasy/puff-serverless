// import { verifySession } from "../../src/session_auth.js" // verifySession is not used here as per the simplified logic

export async function onRequestPost(context) {
  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  // Step 1: Get the token from FormData
  let token
  try {
    const formdata = await context.request.formData()
    token = formdata.get("sessionToken")
  } catch (e) {
    console.error("Error parsing FormData for logout:", e)
    return new Response("Invalid request format.", { status: 400 })
  }

  if (!token) {
    return new Response("Session token is missing in request body.", {
      status: 400,
    })
  }

  // Step 2: Attempt to delete the session token
  try {
    await client.connect()
    const deleteResult = await client.query(
      "DELETE FROM sessions WHERE session_id = $1",
      [token]
    )

    const changes = deleteResult.rowCount
    return new Response(`Sessions deleted: ${changes}`, { status: 200 })
  } catch (error) {
    console.error("Error during session deletion:", error)
    return new Response("Logout failed due to a server error.", { status: 500 })
  } finally {
    await client.end()
  }
}

// Fallback for other methods if needed
export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context) // Route POST to onRequestPost
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
