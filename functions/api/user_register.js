import { puff_hashing_password } from './../../src/hashing.js';
  
export async function onRequest(context) {
  // Step 0. Prep work
  const formdata = (await context.request.formData())
  const email = formdata.get('email')
  // TODO Check the email isn't already registered
  
  // Step 1. Register the user
  const uuid = await crypto.randomUUID()
  const name = formdata.get('name')
  const insert_user = await context.env.DATABASE.prepare('INSERT INTO users (user_uuid, user_name) VALUES (?1, ?2)').bind(uuid, name).run()
  
  // Step 2. Register the email
  const insert_email = await context.env.DATABASE.prepare('INSERT INTO emails (user_uuid, email_address) VALUES (?1, ?2)').bind(uuid, email).run()
  
  // Step 3. Register the password
  const pw = formdata.get('pw')
  const { hash, salt } = await puff_hashing_password(pw)
  const secret_value = hash + ':' + salt
  const now = new Date(Date.now()).toISOString()
  const insert_secret = await context.env.DATABASE.prepare('INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_created_at) VALUES (?1, ?2)').bind(uuid, 'SHA-384', secret_value, now).run()

  let results = {
    ...insert_user,
    ...insert_email,
    ...insert_secret
  }
  return Response.json(results)
}
