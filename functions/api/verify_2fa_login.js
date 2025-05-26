import { authenticator } from "otplib";

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in verify_2fa_login. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Parse JSON body for user_uuid and TOTP code
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { user_uuid, totp_code } = requestBody;

  // Step 2: Input Validation
  if (!user_uuid || typeof user_uuid !== "string") {
    return new Response(
      JSON.stringify({ error: "User UUID is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (!totp_code || typeof totp_code !== "string") {
    return new Response(
      JSON.stringify({ error: "TOTP code is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 3: Retrieve 2FA Secret and check if 2FA is enabled
    const secretRecord = await context.env.DATABASE.prepare(
      "SELECT encrypted_secret, is_enabled FROM two_factor_secrets WHERE user_uuid = ?1"
    )
      .bind(user_uuid)
      .first();

    if (!secretRecord || !secretRecord.encrypted_secret) {
      return new Response(
        JSON.stringify({
          error: "2FA setup not found for this user. Please ensure 2FA is configured.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (secretRecord.is_enabled !== 1) {
      return new Response(
        JSON.stringify({ error: "2FA is not enabled for this account." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // "Decrypt" the secret
    if (!secretRecord.encrypted_secret.startsWith("sim_encrypted::")) {
        console.error(`Invalid secret format for user ${user_uuid}.`);
        return new Response(JSON.stringify({ error: "Internal error with 2FA secret." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const storedSecret = secretRecord.encrypted_secret.replace("sim_encrypted::", "");

    // Step 4: Verify TOTP Code
    const isValid = authenticator.check(totp_code, storedSecret);

    if (isValid) {
      // Step 5: On Successful TOTP Verification, create a new session
      const session_id = crypto.randomUUID();
      const expires_at = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days from now
      ).toISOString();
      const user_agent = context.request.headers.get("User-Agent") || "";
      const ip_address = context.request.headers.get("CF-Connecting-IP") || "";

      await context.env.DATABASE.prepare(
        "INSERT INTO sessions (session_id, user_uuid, expires_at, user_agent, ip_address) VALUES (?1, ?2, ?3, ?4, ?5)"
      )
        .bind(session_id, user_uuid, expires_at, user_agent, ip_address)
        .run();

      return new Response(JSON.stringify({ session_token: session_id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // Step 6: On Failed TOTP Verification
      return new Response(
        JSON.stringify({ error: "Invalid TOTP code." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("Error during 2FA login verification:", error);
    return new Response(
      JSON.stringify({ error: "Failed to verify 2FA login due to a server error." }),
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
