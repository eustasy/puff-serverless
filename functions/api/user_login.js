import { user_login } from "./../../src/users.js" // user_login is now pg-ready

export async function onRequest(context) {
  // Validate context and HYPERDRIVE binding (user_login will also do this)
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    return new Response(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration.",
      { status: 500 }
    )
  }

  const formdata = await context.request.formData()
  const email = formdata.get("email") // Changed from await formdata.get to formdata.get
  const pw = formdata.get("pw") // Changed from await formdata.get to formdata.get

  // Basic validation for email and pw presence
  if (!email || !pw) {
    return new Response("Email and password are required.", { status: 400 })
  }

  try {
    const loginResponse = await user_login(context, email, pw)
    return loginResponse
  } catch (error) {
    console.error("Error in user_login endpoint:", error)
    // user_login itself returns Response objects for errors, but a general catch for unexpected issues.
    return new Response("An unexpected error occurred during login.", {
      status: 500,
    })
  }
}
