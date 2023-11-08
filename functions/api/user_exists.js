import {user_exists} from '../../src/users.js'

export async function onRequest(context) {
	const {searchParams} = new URL(context.request.url)
	const email = searchParams.get('email')
	const count = await user_exists(context, email)
	const results = {
		email,
		count,
		bool: Boolean(count)
	}
	return Response.json(results)
}
