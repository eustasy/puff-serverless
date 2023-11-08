// Import { password_check } from './../../src/passwords.js';

export async function onRequest(context) {
	// Const { searchParams } = new URL(context.request.url)
	// let pw = searchParams.get('pw')
	// let response_html = await password_check(pw)
	// Create a prepared statement with our query
	const ps = context.env.DATABASE.prepare("SELECT * from users")
	const data = await ps.all()

	return Response.json(data)
}
