import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed
import { authenticator } from "otplib"; // Using otplib

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in setup_2fa_verify. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Verify the session
  const sessionVerificationResult = await verifySession(context);
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult; // Auth failed or error occurred
  }
  // If true, context.data.user_uuid is populated
  const user_uuid = context.data.user_uuid;

  // Step 2: Parse JSON body for TOTP code
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
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      JSON.stringify({ error: "TOTP code is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 3: Retrieve Stored Secret
    const secretRecord = await context.env.DATABASE.prepare(
      "SELECT encrypted_secret, is_enabled FROM two_factor_secrets WHERE user_uuid = ?1"
    )
      .bind(user_uuid)
      .first();

    if (!secretRecord || !secretRecord.encrypted_secret) {
      return new Response(
        JSON.stringify({
          error: "2FA setup not initiated or secret not found. Please start setup first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (secretRecord.is_enabled === 1) {
        return new Response(
            JSON.stringify({
              message: "2FA is already verified and enabled.", // Or error: "2FA already enabled"
            }),
            { status: 200, headers: { "Content-Type": "application/json" } } // Or 400 if considered an error
          );
    }

    // "Decrypt" the secret
    if (!secretRecord.encrypted_secret.startsWith("sim_encrypted::")) {
        console.error(`Invalid secret format for user ${user_uuid}.`);
        return new Response(JSON.stringify({ error: "Internal error with secret storage." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const storedSecret = secretRecord.encrypted_secret.replace("sim_encrypted::", "");

    // Step 4: Verify TOTP Code
    const isValid = authenticator.check(totp_code, storedSecret);

    if (isValid) {
      // Step 5: On Successful Verification, enable 2FA
      await context.env.DATABASE.prepare(
        "UPDATE two_factor_secrets SET is_enabled = 1 WHERE user_uuid = ?1"
      )
        .bind(user_uuid)
        .run();

      return new Response(
        JSON.stringify({ message: "2FA setup successful and enabled." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // Step 6: On Failed Verification
      return new Response(
        JSON.stringify({ error: "Invalid TOTP code. Please try again." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Error during 2FA verification:", error);
    return new Response(
      JSON.stringify({ error: "Failed to verify 2FA setup due to a server error." }),
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
  // For POST requests, onRequestPost will be called by the Cloudflare Pages runtime.
}
