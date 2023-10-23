import { password_requirements } from './../../src/passwords.js';
  
export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')
  let response_html = await password_requirements(pw)
  return new Response(response_html)
}
