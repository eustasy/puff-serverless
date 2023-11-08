import {user_register} from '../../src/users.js'

export async function onRequest(context) {
	const formdata = await context.request.formData()
	const email = await formdata.get('email')
	const name = await formdata.get('name')
	const pw = await formdata.get('pw')
	const results = await user_register(context, name, email, pw)
	return new Response(results)
}
