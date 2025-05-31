import { user_register } from "../../../src/users.js" // user_register is now pg-ready

export async function onRequest(context) {
  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const name = formdata.get("name")
  const pw = formdata.get("pw")

  // Basic validation for required fields
  if (!email || !name || !pw) {
    return new Response(
      '<p class="error">Name, email, and password are required.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const results = await user_register(context, name, email, pw)
    if (results && results.success) {
      // Redirect to login page on successful registration
      return new Response(null, {
        status: 303, // See Other, to redirect after POST
        headers: {
          "HX-Redirect":
            "/login?message=Registration successful. Please check your email to verify.",
        },
      })
    } else {
      // This case might be hit if user_register returns something unexpected without throwing an error
      return new Response(
        '<p class="error">Registration failed. Please try again.</p>',
        {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
  } catch (error) {
    console.error("Error in user_register endpoint:", error)
    if (error.message === "Email is already registered.") {
      return new Response(`<p class="error">${error.message}</p>`, {
        status: 409, // 409 Conflict is appropriate for existing email
        headers: { "Content-Type": "text/html" },
      })
    }
    return new Response(
      '<p class="error">An unexpected error occurred during registration.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}
