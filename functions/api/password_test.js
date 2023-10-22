export function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')
  if ( pw.length >= 12 ) {}
  return new Response(`${pw} ${pw.length}`)
}
