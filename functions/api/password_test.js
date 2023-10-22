export function onRequest(context) {
  const { searchParams } = new URL(context.request.url)

  let pw = searchParams.get('pw')
  var response_html = '<div id="pw-checklist"><h3>Password Requirements</h3><ul>'

  if ( pw.length >= 12 ) {
    response_html += '<li style="color:#064e3b"><strong>Must</strong> be at least 12 characters long</li>'
  } else {
    response_html += '<li style="color:#7f1d1d"><strong>Must</strong> be at least 12 characters long</li>'
  }
  var hasNumber = /\d/
  //hasNumber.test("ABC33SDF");  // true
  //hasNumber.test("ABCSDF");  // false 
  if ( hasNumber.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a number</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a number</li>'
  }

  var hasSpecial = /[!-\/:-@[-`{-~]/
  if ( hasSpecial.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a special character</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a special character</li>'
  }

// <li>Should not be compronised</li>

  response_html += '</ul></div>'
  return new Response(response_html)
}
