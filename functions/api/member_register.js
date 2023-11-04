import { generate_uuidv4 } from './../../src/uuids.js';
  
export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let name = searchParams.get('name')
  const uuid = await generate_uuidv4()
  const { duration } = (await db.prepare('INSERT INTO users (uuid, name) VALUES (?1, ?2)').bind(uuid, name).run()).meta
  return new Response(duration)
}
