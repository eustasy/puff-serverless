import { puff_hashing_password } from "./utilities_hashing.js"

export async function user_register(context, name, email, password) {
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
  const insert_email = await context.env.DATABASE.prepare(
    "INSERT INTO emails (user_uuid, email_address) VALUES (?1, ?2)"
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
  return results
}

export async function user_exists(context, email) {
  const total = await context.env.DATABASE.prepare(
    "SELECT COUNT(*) AS total FROM emails WHERE email_address = ?1 LIMIT 1"
  )
    .bind(email)
    .first("total")
  return total
}

export async function getUserByEmail(context, email) {
  // Step 1: Fetch User and Email Data
  const emailRecord = await context.env.DATABASE.prepare(
    "SELECT user_uuid FROM emails WHERE email_address = ?1 LIMIT 1"
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
    .first();

  if (!secretRecord || !secretRecord.secret_value) {
    return null; // Password secret not found for user
  }

  // Step 3: Parse Secret and Return User Object
  const [hashedPassword, salt] = secretRecord.secret_value.split(':');

  if (!hashedPassword || !salt) {
    // Handle error: secret_value is not in the expected "hash:salt" format
    console.error("Invalid secret_value format for user_uuid:", user_uuid);
    return null;
  }

  return {
    user_uuid: user_uuid,
    email: email, // The input email
    hashedPassword: hashedPassword,
    salt: salt,
  };
}

export async function user_login(context, email, password) {
  const { verifyPassword } = await import("./passwords.js"); // Dynamic import

  const user = await getUserByEmail(context, email);

  if (user) {
    // Assuming verifyPassword needs the plain password, the salt, and the stored hash.
    // And that user.hashedPassword is just the hash, and user.salt is the salt.
    const passwordMatches = await verifyPassword(password, user.salt, user.hashedPassword);
    if (passwordMatches) {
      // Session Creation (Placeholder)
      return "Login successful! Session created.";
    } else {
      return "Invalid email or password.";
    }
  } else {
    return "Invalid email or password.";
  }
}
