export async function onRequest(context) {
  let response_html = await crypto.randomUUID()
  return new Response(response_html)
}
