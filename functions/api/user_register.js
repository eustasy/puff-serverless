import { generate_uuidv4 } from './../../src/uuids.js';
  
export async function onRequest(context) {
  // Step 0. Prep work
  const formdata = (await context.request.formData())
  const email = formdata.get('email')
  // TODO Check the email isn't already registered
  
  // Step 1. Register the user
  const uuid = await generate_uuidv4()
  const name = formdata.get('name')
  const insert_user = await context.env.DATABASE.prepare('INSERT INTO users (user_uuid, user_name) VALUES (?1, ?2)').bind(uuid, name).run()
  
  // Step 2. Register the email
  const insert_email = await context.env.DATABASE.prepare('INSERT INTO emails (user_uuid, email_address) VALUES (?1, ?2)').bind(uuid, email).run()
  
  // Step 3. Register the password
  const pw = formdata.get('pw')

  let results = {
      ...insert_user,
      ...insert_email
  }
  return Response.json(results)
}
