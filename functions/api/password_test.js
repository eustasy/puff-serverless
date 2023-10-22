export function onRequest(context) {
  const { searchParams } = new URL(context.request.url)
  let pw = searchParams.get('pw')
  var response_html = '<div id="pw-checklist"><h3>Password Requirements</h3><ul>'
  if ( pw.length >= 12 ) {
    response_html += '<li style="color:#064e3b"><strong>Must</strong> be at least 12 character long</li>'
  } else {
    response_html += '<li style="color:#7f1d1d"><strong>Must</strong> be at least 12 character long</li>'
  }
  response_html += '</ul></div>'
  return new Response(response_html)
}
