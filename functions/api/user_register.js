import { user_register } from "./../../src/users.js" // user_register is now pg-ready

export async function onRequest(context) {
  // Validate context and HYPERDRIVE binding (user_register will also do this)
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    return new Response(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration.",
      { status: 500 }
    )
  }

  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const name = formdata.get("name")
  const pw = formdata.get("pw")

  // Basic validation for required fields
  if (!email || !name || !pw) {
    return new Response("Name, email, and password are required.", {
      status: 400,
    })
  }

  try {
    const results = await user_register(context, name, email, pw)
    // user_register (migrated) returns an object like { success: true, user_uuid, email } or throws an error.
    // The API endpoint should ideally return a JSON response for success or a proper error response.
    if (results && results.success) {
      return new Response(
        JSON.stringify({
          message:
            "User registered successfully. Please check your email to verify.",
          userId: results.user_uuid,
        }),
        {
          status: 201, // 201 Created is more appropriate for successful registration
          headers: { "Content-Type": "application/json" },
        }
      )
    } else {
      // This case might be hit if user_register returns something unexpected without throwing an error
      return new Response(
        JSON.stringify({ error: "Registration failed. Please try again." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      )
    }
  } catch (error) {
    console.error("Error in user_register endpoint:", error)
    // Handle specific errors like "Email is already registered."
    if (error.message === "Email is already registered.") {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 409, // 409 Conflict is appropriate for existing email
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({
        error: "An unexpected error occurred during registration.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    )
  }
}
