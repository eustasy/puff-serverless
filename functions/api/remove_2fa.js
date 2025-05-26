import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed
import { authenticator } from "otplib"; // Using otplib

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in remove_2fa. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Session Verification
  const sessionVerificationResult = await verifySession(context);
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult; // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid;

  // Step 2: Parse JSON body
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const totp_code = requestBody.totp_code;

  // Step 3: Input Validation
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      JSON.stringify({ error: "TOTP code is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 4: Check if 2FA is Enabled and retrieve secret from 'secrets' table
    const secretRecord = await context.env.DATABASE.prepare(
      "SELECT secret_value, secret_enabled FROM secrets WHERE user_uuid = ?1 AND secret_type = 'totp_secret'"
    )
      .bind(user_uuid)
      .first();

    if (!secretRecord || secretRecord.secret_enabled !== 1) {
      return new Response(
        JSON.stringify({
          error: "2FA is not currently enabled for this account.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 5: Verify TOTP Code
    // "Decrypt" the secret_value
    if (!secretRecord.secret_value || !secretRecord.secret_value.startsWith("sim_encrypted::")) {
        console.error(`Invalid or missing secret_value format for user ${user_uuid} of type 'totp_secret' during 2FA removal.`);
        return new Response(JSON.stringify({ error: "Internal error with 2FA configuration." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const storedSecret = secretRecord.secret_value.replace("sim_encrypted::", "");

    const isValid = authenticator.check(totp_code, storedSecret);

    if (!isValid) {
      return new Response(
        JSON.stringify({ error: "Invalid TOTP code." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 6: Remove 2FA Configuration (Delete the row from 'secrets' table)
    const deleteStmt = await context.env.DATABASE.prepare(
      "DELETE FROM secrets WHERE user_uuid = ?1 AND secret_type = 'totp_secret'"
    )
      .bind(user_uuid)
      .run();

    if (deleteStmt.meta.changes === 0) {
        // This would be unusual if the previous checks passed and TOTP was valid.
        // Could indicate a race condition or that the record was deleted by another process
        // between the check and the deletion.
        console.warn(`Failed to delete 2FA record for user ${user_uuid}, record possibly already deleted.`);
        // Still, from the user's perspective, 2FA is not active if the record is gone.
        // So, we can return a success message, but log a warning.
    }

    // Step 7: Response
    return new Response(
      JSON.stringify({
        message: "Two-factor authentication has been removed successfully.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error during 2FA removal:", error);
    return new Response(
      JSON.stringify({ error: "Failed to remove 2FA due to a server error." }),
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
