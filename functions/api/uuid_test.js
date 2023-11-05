import { generate_uuidv4 } from "./../../src/uuids.js"

export async function onRequest(context) {
  let response_html = await generate_uuidv4()
  return new Response(response_html)
}
