import { getUserByEmail } from "../../src/users.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in request_password_reset. Check Pages Function configuration."
    );
    // Even in this case, return a generic message to avoid leaking info about server state
    return new Response(
      JSON.stringify({
        message:
          "If an account exists for the provided email, a password reset link has been sent.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Parse JSON body for email
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({
        message: "Invalid request body. Please provide an email.", // Slightly more specific for bad requests
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const email = requestBody.email;

  // Step 2: Input Validation
  if (!email || typeof email !== "string" || !email.includes("@")) {
    // Still return a generic message, but log the specific error
    console.warn("Password reset request with invalid email format.");
    return new Response(
      JSON.stringify({
        message:
          "If an account exists for the provided email, a password reset link has been sent.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const genericSuccessResponse = new Response(
    JSON.stringify({
      message:
        "If an account exists for this email, a password reset link has been sent.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  try {
    // Step 3: User Lookup
    // getUserByEmail returns { user_uuid, email, is_verified, hashedPassword, salt } or null
    const user = await getUserByEmail(context, email);

    if (user && user.user_uuid) {
      // Step 4: Token Generation
      const token_value = crypto.randomUUID(); // Renamed from reset_token
      const token_expires_at = new Date(
        Date.now() + 1 * 60 * 60 * 1000 // 1 hour from now
      ).toISOString();

      // Step 5: Store Token
      await context.env.DATABASE.prepare(
        "INSERT INTO tokens (user_uuid, token_type, token_value, expires_at) VALUES (?1, 'password_reset', ?2, ?3)"
      )
        .bind(user.user_uuid, token_value, token_expires_at)
        .run();

      // Step 6: Email Sending (Simulated)
      console.log(
        `Password reset link for ${email}: /api/reset_password?token=${token_value} (Note: This is an API endpoint, a real link would go to a UI page).`
      );
    } else {
      // Email not found or user_uuid missing, log this internally
      console.log(
        `Password reset requested for non-existent or unlinked email: ${email}`
      );
    }

    // Step 7: Response (Always generic)
    return genericSuccessResponse;
  } catch (error) {
    console.error("Error during password reset request:", error);
    // In case of an unexpected server error, still return the generic message
    // to avoid leaking any information about the error.
    return genericSuccessResponse;
  }
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
  // For POST requests, Cloudflare Pages will automatically route to onRequestPost.
}
