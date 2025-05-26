import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed
import { authenticator } from "otplib"; // Using otplib

const APP_NAME = "YourApp"; // Could be a configurable value

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in setup_2fa_start. Check Pages Function configuration."
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

  try {
    // Step 2: Check Existing 2FA
    const existing2FARecord = await context.env.DATABASE.prepare(
      "SELECT is_enabled FROM two_factor_secrets WHERE user_uuid = ?1"
    )
      .bind(user_uuid)
      .first();

    if (existing2FARecord && existing2FARecord.is_enabled === 1) {
      return new Response(
        JSON.stringify({
          error: "2FA is already enabled. Please remove the existing setup first.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch user's email for the label
    const emailRecord = await context.env.DATABASE.prepare(
      "SELECT email_address FROM emails WHERE user_uuid = ?1 ORDER BY email_id ASC LIMIT 1" // Assuming first email is primary
    )
      .bind(user_uuid)
      .first();

    if (!emailRecord) {
      console.error(`No email found for user_uuid: ${user_uuid}`);
      return new Response(
        JSON.stringify({ error: "User email not found, cannot setup 2FA." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    const userEmail = emailRecord.email_address;
    const label = `${APP_NAME}:${userEmail}`;

    // Step 3: Generate TOTP Secret
    const secret = authenticator.generateSecret(); // Generates a base32 secret

    // Step 4: "Simulated" Encryption
    const encrypted_secret = `sim_encrypted::${secret}`;

    // Step 5: Store Secret (Temporarily/Unverified)
    // Use REPLACE INTO (or INSERT OR REPLACE) to handle existing incomplete setups
    const now = new Date().toISOString();
    await context.env.DATABASE.prepare(
      `INSERT OR REPLACE INTO two_factor_secrets 
       (user_uuid, secret_type, encrypted_secret, is_enabled, created_at, label) 
       VALUES (?1, 'TOTP', ?2, 0, ?3, ?4)`
    )
      .bind(user_uuid, encrypted_secret, now, label)
      .run();

    // Step 6: Generate QR Code Data (TOTP Auth URI)
    const otpauthUri = authenticator.keyuri(userEmail, APP_NAME, secret);

    // Step 7: Response
    return new Response(
      JSON.stringify({
        qr_code_uri: otpauthUri,
        manual_setup_code: secret,
        message:
          "Scan the QR code or enter the manual setup code in your authenticator app, then verify.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error during 2FA setup start:", error);
    return new Response(
      JSON.stringify({ error: "Failed to start 2FA setup due to a server error." }),
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
