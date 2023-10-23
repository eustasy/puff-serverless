import { password_requirements } from './../../src/passwords.js';
  
export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')
  try {
    var response_html = await password_requirements(pw)
  } catch (err) {
      response_html = err
  }
  return new Response(response_html)
}
