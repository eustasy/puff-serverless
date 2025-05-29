import { getUserByEmail } from "../../src/users.js" // Adjust path as needed
const { Client } = require("pg")

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in request_password_reset. Check Pages Function configuration."
    )
    // Even in this case, return a generic message to avoid leaking info about server state
    return new Response(
      JSON.stringify({
        message:
          "If an account exists for the provided email, a password reset link has been sent.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }

  // Step 1: Parse JSON body for email
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(
      JSON.stringify({
        message: "Invalid request body. Please provide an email.", // Slightly more specific for bad requests
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const email = requestBody.email

  // Step 2: Input Validation
  if (!email || typeof email !== "string" || !email.includes("@")) {
    // Still return a generic message, but log the specific error
    console.warn("Password reset request with invalid email format.")
    return new Response(
      JSON.stringify({
        message:
          "If an account exists for the provided email, a password reset link has been sent.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }

  const genericSuccessResponse = new Response(
    JSON.stringify({
      message:
        "If an account exists for this email, a password reset link has been sent.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )

  const client = new Client({
    connectionString: context.env.HYPERDRIVE.connectionString,
  })

  try {
    // Step 3: User Lookup
    // getUserByEmail is already migrated and uses pg client internally
    const user = await getUserByEmail(context, email)

    if (user && user.user_uuid) {
      await client.connect() // Connect only if we need to insert a token
      // Step 4: Token Generation
      const token_value = crypto.randomUUID()
      const token_expires_at = new Date(
        Date.now() + 1 * 60 * 60 * 1000 // 1 hour from now
      ).toISOString()

      // Step 5: Store Token
      const insertTokenQuery = {
        text: "INSERT INTO tokens (user_uuid, token_type, token_value, expires_at) VALUES ($1, \'password_reset\', $2, $3)",
        values: [user.user_uuid, token_value, token_expires_at],
      }
      await client.query(insertTokenQuery)

      // Step 6: Email Sending (Simulated)
      console.log(
        `Password reset link for ${email}: /api/reset_password?token=${token_value} (Note: This is an API endpoint, a real link would go to a UI page).`
      )
    } else {
      // Email not found or user_uuid missing, log this internally
      console.log(
        `Password reset requested for non-existent or unlinked email: ${email}`
      )
    }

    // Step 7: Response (Always generic)
    return genericSuccessResponse
  } catch (error) {
    console.error("Error during password reset request:", error)
    return genericSuccessResponse
  } finally {
    if (client && client._connected) {
      // Check if client was connected before trying to end
      await client.end()
    }
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context) // Ensure onRequestPost is awaited
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  })
}
