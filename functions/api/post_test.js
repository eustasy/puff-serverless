import { password_requirements } from './../../src/passwords.js';

export async function onRequest(context) {
  const formdata = (await context.request.formData())
  const name = formdata.get('name')
  const email = formdata.get('email')
  const pw = formdata.get('pw')

  const result = [
    'name': name,
    'email': email,
    'pw': pw
  ]
  return Response.json(result)
}
