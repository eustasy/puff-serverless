import { generate_uuidv4 } from './uuids.js';
import { password_check } from './passwords.js';
  
export async function user_register(context, name, email, password) {
  // Step 0. Prep work
  // TODO Check the email isn't already registered
  
  // Step 1. Register the user
  const uuid = await generate_uuidv4()
  const insert_user = await context.env.DATABASE.prepare('INSERT INTO users (user_uuid, user_name) VALUES (?1, ?2)').bind(uuid, name).run()
  
  // Step 2. Register the email
  const insert_email = await context.env.DATABASE.prepare('INSERT INTO emails (user_uuid, email_address) VALUES (?1, ?2)').bind(uuid, email).run()
  
  // Step 3. Register the password
  const insert_password = await context.env.DATABASE.prepare('INSERT INTO secrets (user_uuid, secret_type, secret) VALUES (?1, "password", ?2)').bind(uuid, password).run()

  let results = {
      ...insert_user,
      ...insert_email,
      ...insert_password
  }
  return results
}
