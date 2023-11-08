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
    ...insert_password
  }
  return results
}

export async function user_exists(context, email) {
  const total = await context.env.DATABASE.prepare(
    "SELECT COUNT(*) AS total FROM emails WHERE email_address = ?1 LIMIT 1"
  )
    .bind(email)
    .first("total")
  return Boolean(total)
}
