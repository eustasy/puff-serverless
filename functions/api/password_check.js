import { password_check } from './../../src/passwords.js';
  
export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')
  var response_html = await password_check(pw)
  return new Response(response_html)
}
