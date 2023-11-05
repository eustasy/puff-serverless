import { password_requirements } from './../../src/passwords.js';
  
export async function onRequest(context) {
  const formdata = context.request.formdata()
  let pw = formdata.get('pw')
  let response_html = await password_requirements(pw)
  return new Response(response_html)
}
