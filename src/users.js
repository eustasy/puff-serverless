import { puff_hashing_password } from "./utilities_hashing.js"

export async function user_register(context, name, email, password) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    throw new Error(
      "D1 Database binding [DATABASE] not found. Please check Pages Function configuration."
    )
  }

  // Step 0. Prep work
  // TODO Check the email isn't already registered

  // Step 1. Register the user
  const uuid = await crypto.randomUUID()
  const insert_user = await context.env.DATABASE.prepare(
    "INSERT INTO users (user_uuid, user_name) VALUES (?1, ?2)"
  )
    .bind(uuid, name)
    .run()

  // Step 2. Register the email
  // Set is_primary = 1 for the initial email, is_verified defaults to 0
  const insert_email = await context.env.DATABASE.prepare(
    "INSERT INTO emails (user_uuid, email_address, is_primary) VALUES (?1, ?2, 1)"
  )
    .bind(uuid, email)
    .run()

  // Step 3. Register the password
  const now = new Date(Date.now()).toISOString()
  const { hash, salt } = await puff_hashing_password(password)
  const secret_value = hash + ":" + salt
  const insert_password = await context.env.DATABASE.prepare(
    "INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_created_at) VALUES (?1, 'puff_password_sha-384', ?2, ?3)"
  )
    .bind(uuid, secret_value, now)
    .run()

  let results = {
    ...insert_user,
    ...insert_email,
    ...insert_password,
  }

  // Step 4. Generate and store email verification token
  const verification_token = crypto.randomUUID()
  const token_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now

  const insert_token = await context.env.DATABASE.prepare(
    "INSERT INTO email_verifications (user_uuid, email_address, verification_token, token_expires_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(uuid, email, verification_token, token_expires_at)
    .run()

  results = {
    ...results,
    ...insert_token,
  }

  // Log the verification link
  console.log(`Verification link: /api/verify_email?token=${verification_token}`)

  return results
}

export async function user_exists(context, email) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    throw new Error(
      "D1 Database binding [DATABASE] not found. Please check Pages Function configuration."
    )
  }

  const total = await context.env.DATABASE.prepare(
    "SELECT COUNT(*) AS total FROM emails WHERE email_address = ?1 LIMIT 1"
  )
    .bind(email)
    .first("total")
  return total
}

export async function getUserByEmail(context, email) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    throw new Error(
      "D1 Database binding [DATABASE] not found. Please check Pages Function configuration."
    )
  }

  // Step 1: Fetch User and Email Data
  const emailRecord = await context.env.DATABASE.prepare(
    "SELECT user_uuid, is_verified FROM emails WHERE email_address = ?1 LIMIT 1"
  )
    .bind(email)
    .first();

  if (!emailRecord || !emailRecord.user_uuid) {
    return null; // User not found by email
  }

  const user_uuid = emailRecord.user_uuid;

  // Step 2: Fetch Password Secret
  const secretRecord = await context.env.DATABASE.prepare(
    "SELECT secret_value FROM secrets WHERE user_uuid = ?1 AND secret_type = 'puff_password_sha-384' LIMIT 1"
  )
    .bind(user_uuid)
    .first()

  if (!secretRecord || !secretRecord.secret_value) {
    return null // Password secret not found for user
  }

  // Step 3: Parse Secret and Return User Object
  const [hashedPassword, salt] = secretRecord.secret_value.split(":")

  if (!hashedPassword || !salt) {
    // Handle error: secret_value is not in the expected "hash:salt" format
    console.error("Invalid secret_value format for user_uuid:", user_uuid);
    return null;
  }

  return {
    user_uuid: user_uuid,
    email: email, // The input email
    is_verified: emailRecord.is_verified, // Add is_verified status
    hashedPassword: hashedPassword,
    salt: salt,
  };
}

export async function user_login(context, email, password) {
  const { verifyPassword } = await import("./passwords.js"); // Dynamic import

  const user = await getUserByEmail(context, email);

  if (!user) {
    return new Response(
      JSON.stringify({ error: "Invalid email or password." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Check if email is verified
  if (!user.is_verified) {
    return new Response(
      JSON.stringify({ error: "Please verify your email before logging in." }),
      { status: 403, headers: { "Content-Type": "application/json" } } // 403 Forbidden
    );
  }

  const passwordMatches = await verifyPassword(
    password,
    user.salt,
    user.hashedPassword
  );

  if (passwordMatches) {
    // Check if 2FA is enabled for the user
    const twoFactorRecord = await context.env.DATABASE.prepare(
      "SELECT is_enabled FROM two_factor_secrets WHERE user_uuid = ?1"
    )
      .bind(user.user_uuid)
      .first();

    if (twoFactorRecord && twoFactorRecord.is_enabled === 1) {
      // 2FA is enabled, respond that TOTP is required
      return new Response(
        JSON.stringify({
          status: "2fa_required",
          message: "Please provide your TOTP code.",
          user_uuid: user.user_uuid, // Send user_uuid for the next step
        }),
        { status: 200, headers: { "Content-Type": "application/json" } } // Status 200 as it's an expected intermediate step
      );
    } else {
      // 2FA is not enabled, proceed with direct session creation
      const session_id = crypto.randomUUID();
      const expires_at = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ).toISOString(); // 7 days from now
      const user_agent = context.request.headers.get("User-Agent") || "";
      const ip_address = context.request.headers.get("CF-Connecting-IP") || "";

      try {
        await context.env.DATABASE.prepare(
          "INSERT INTO sessions (session_id, user_uuid, expires_at, user_agent, ip_address) VALUES (?1, ?2, ?3, ?4, ?5)"
        )
          .bind(
            session_id,
            user.user_uuid,
            expires_at,
            user_agent,
            ip_address
          )
          .run();

        return new Response(JSON.stringify({ session_token: session_id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (dbError) {
        console.error("Database error during session creation:", dbError);
        return new Response(
          JSON.stringify({ error: "Failed to create session." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  } else {
    return new Response(
      JSON.stringify({ error: "Invalid email or password." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
}
