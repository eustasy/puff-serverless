import {password_check} from '../../src/passwords.js'

export async function onRequest(context) {
	const pw = (await context.request.formData()).get('pw')
	const response_html = await password_check(pw)
	return new Response(response_html)
}
