import { generate_uuidv4 } from './../../src/uuids.js';
  
export async function onRequest(context) {
  // Step 0. Prep work
  const { searchParams } = new URL(context.request.url)
  let name = searchParams.get('name')
  const uuid = await generate_uuidv4()
  // Step 1. Register the member
  const { duration } = (await db.prepare('INSERT INTO users (uuid, name) VALUES (?1, ?2)').bind(uuid, name).run()).meta
  // Step 2. Register the email
  // Step 3. Register the password
  return new Response(duration)
}
