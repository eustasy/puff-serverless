export async function onRequest(context) {
	const response_html = await crypto.randomUUID()
	return new Response(response_html)
}
