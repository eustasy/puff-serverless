export async function onRequestGet(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    return new Response(
      "D1 Database binding [DATABASE] not found. Please check Pages Function configuration.",
      { status: 500 }
    );
  }

  const { searchParams } = new URL(context.request.url);
  const token = searchParams.get("token");

  if (!token) {
    return new Response("Verification token is missing.", { status: 400 });
  }

  try {
    // Step 1: Query the database for the token
    const verificationRecord = await context.env.DATABASE.prepare(
      "SELECT * FROM email_verifications WHERE verification_token = ?1"
    )
      .bind(token)
      .first();

    if (!verificationRecord) {
      return new Response("Invalid or expired token.", { status: 400 });
    }

    // Step 2: Validate token expiration
    const now = new Date();
    const tokenExpiresAt = new Date(verificationRecord.token_expires_at);

    if (now > tokenExpiresAt) {
      // Optionally, delete the expired token
      await context.env.DATABASE.prepare(
        "DELETE FROM email_verifications WHERE verification_token = ?1"
      )
        .bind(token)
        .run();
      return new Response("Verification token expired.", { status: 400 });
    }

    // Step 3: Mark email as verified
    const user_uuid = verificationRecord.user_uuid;
    const email_address = verificationRecord.email_address;
    const verified_at = new Date().toISOString();

    const updateEmailStmt = await context.env.DATABASE.prepare(
      "UPDATE emails SET is_verified = 1, verified_at = ?1 WHERE user_uuid = ?2 AND email_address = ?3"
    )
      .bind(verified_at, user_uuid, email_address)
      .run();

    if (updateEmailStmt.meta.changes === 0) {
        // This case might happen if the email was deleted or user_uuid/email_address didn't match
        console.error(`Failed to update email verification status for token: ${token}, user_uuid: ${user_uuid}, email: ${email_address}`);
        return new Response("Failed to verify email. Please try registering again or contact support.", { status: 500 });
    }
    
    // Step 4: Delete the token from email_verifications to prevent reuse
    await context.env.DATABASE.prepare(
      "DELETE FROM email_verifications WHERE verification_token = ?1"
    )
      .bind(token)
      .run();

    return new Response("Email verified successfully. You can now log in.", {
      status: 200,
    });
  } catch (error) {
    console.error("Error during email verification:", error);
    return new Response("An internal server error occurred.", { status: 500 });
  }
}
