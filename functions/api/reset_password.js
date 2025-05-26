import { password_check, password_requirements_html } from "../../src/passwords.js"; // Adjust path as needed
import { puff_hashing_password } from "../../src/utilities_hashing.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in reset_password. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Parse JSON body
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { token, new_password } = requestBody;

  // Step 2: Input Validation
  if (!token || typeof token !== "string") {
    return new Response(
      JSON.stringify({ error: "Reset token is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      JSON.stringify({ error: "New password is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 3: Password Strength Check
    const passwordCheckResult = password_check(new_password);
    if (!passwordCheckResult.strong) {
      // You can choose to send back the HTML requirements or a simpler message
      // For this example, sending a simple message with the HTML as part of the error object.
      return new Response(
        JSON.stringify({
          error: "Password does not meet requirements.",
          requirements_html: password_requirements_html(), // Send HTML for client-side display
          details: passwordCheckResult.error, // More specific error details
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 4: Token Validation
    const tokenRecord = await context.env.DATABASE.prepare(
      "SELECT user_uuid, expires_at, is_used FROM tokens WHERE token_value = ?1 AND token_type = 'password_reset'"
    )
      .bind(token)
      .first();

    if (!tokenRecord) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired password reset token." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (tokenRecord.is_used === 1) { // Check if is_used is 1 (true)
      return new Response(
        JSON.stringify({ error: "Password reset token has already been used." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const now = new Date();
    const tokenExpiresAt = new Date(tokenRecord.expires_at); // Use expires_at
    if (now > tokenExpiresAt) {
      // Optionally, mark the token as used if it's expired, to prevent re-querying valid but expired tokens.
      await context.env.DATABASE.prepare(
        "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'password_reset'"
      )
        .bind(token)
        .run();
      return new Response(
        JSON.stringify({ error: "Password reset token has expired." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const user_uuid = tokenRecord.user_uuid;

    // Step 5: Hash the new password
    const { hash, salt } = await puff_hashing_password(new_password);
    const secret_value = hash + ":" + salt;
    const secret_updated_at = new Date().toISOString();

    // Step 6: Update Password in secrets table
    // Assuming only one 'puff_password_sha-384' per user. If multiple, need more specific logic.
    const updatePasswordStmt = await context.env.DATABASE.prepare(
      "UPDATE secrets SET secret_value = ?1, secret_created_at = ?2 WHERE user_uuid = ?3 AND secret_type = 'puff_password_sha-384'"
    )
      .bind(secret_value, secret_updated_at, user_uuid)
      .run();
    
    if (updatePasswordStmt.meta.changes === 0) {
        console.error(`Failed to update password for user_uuid: ${user_uuid}. User or secret type not found.`);
        // This could indicate an issue, like the user's primary password record was deleted.
        return new Response(JSON.stringify({ error: "Failed to update password. User record issue." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    // Step 7: Invalidate Token
    await context.env.DATABASE.prepare(
      "UPDATE tokens SET is_used = 1 WHERE token_value = ?1 AND token_type = 'password_reset'"
    )
      .bind(token)
      .run();

    // Step 8: Response
    return new Response(
      JSON.stringify({ message: "Password has been reset successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error during password reset:", error);
    return new Response(
      JSON.stringify({ error: "Failed to reset password due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
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
