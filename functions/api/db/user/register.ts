import { user_register } from "../../../../src/users.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  const formdata = await context.request.formData()
  const email = formdata.get("email")
  const name = formdata.get("name")
  const pw = formdata.get("pw")

  // Basic validation for required fields
  if (
    typeof email !== "string" ||
    typeof name !== "string" ||
    typeof pw !== "string" ||
    !email ||
    !name ||
    !pw
  ) {
    return new Response(
      '<p class="result-negative">Name, email, and password are required.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const results = await user_register(dbClient, name, email, pw)
    if (results && results.success) {
      // Redirect to login page on successful registration
      return new Response(null, {
        status: 303, // See Other, to redirect after POST
        headers: {
          "HX-Redirect": "/login?code=registration_success",
        },
      })
    } else {
      // This case might be hit if user_register returns something unexpected without throwing an error
      return new Response(
        '<p class="result-negative">Registration failed. Please try again.</p>',
        {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
  } catch (error) {
    console.error("Error in user_register endpoint:", error)
    if (
      error instanceof Error &&
      error.message === "Email is already registered."
    ) {
      return new Response(`<p class="result-negative">${error.message}</p>`, {
        status: 409, // 409 Conflict is appropriate for existing email
        headers: { "Content-Type": "text/html" },
      })
    }
    return new Response(
      '<p class="result-negative">An unexpected error occurred during registration.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
