import { puff_hashing_sha1_hibp } from './utilities_hashing.js'

export async function password_check(pw) {
  var result = true
  if ( pw.length < 12 ) {
    result = false
  }
  var hasNumber = /\d/
  if ( !hasNumber.test(pw) ) {
    result = false
  }
  var hasSpecial = /[!-\/:-@[-`{-~]/
  if ( !hasSpecial.test(pw) ) {
    result = false
  }
  return result
}

export async function password_requirements(pw) {
  var response_html = '<h3>Password Requirements</h3><ul>'

  if ( pw.length >= 12 ) {
    response_html += '<li style="color:#064e3b"><strong>Must</strong> be at least 12 characters long</li>'
  } else {
    response_html += '<li style="color:#7f1d1d"><strong>Must</strong> be at least 12 characters long</li>'
  }

  var hasNumber = /\d/
  // TODO Test these assertions:
  //hasNumber.test("ABC33SDF");  // true
  //hasNumber.test("ABCSDF");  // false 
  if ( hasNumber.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a number</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a number</li>'
  }

  var hasSpecial = /[^a-zA-Z\d]/
  if ( hasSpecial.test(pw) ) {
    response_html += '<li style="color:#064e3b">Should contain a special character</li>'
  } else {
    response_html += '<li style="color:#7f1d1d">Should contain a special character</li>'
  }

  var pw_sha1 = await puff_hashing_sha1_hibp(pw)
  //response_html += '<li>' + pw_sha1.f5 + ' : ' + pw_sha1.l35 + '</li>'
  try {
    var compromised = 0
    await fetch('https://api.pwnedpasswords.com/range/' + pw_sha1.f5)
    .then((response) => response.text())
    .then((text) => {
      //response_html += '<li>' + text + '</li>'
      var inputArray = text.split('\n')
      // TODO Minor perf improvement: This for loop always runs the full length, but if we wrap it in a non-exported function we can `return` when we find a match.
      for (var i = 0; i < inputArray.length; i++) {
        let line_f35 = inputArray[i].slice(0, 35)
        let line_ln = inputArray[i].substring(36)
        //response_html += '<li>' + i + ' : ' + line_f35 + ' : ' + line_ln + '</li>'
        if ( line_f35 == pw_sha1.l35.toUpperCase() ) {
          compromised = parseInt(line_ln)
        }
      }
    })

    if ( compromised > 0 ) {
      response_html += '<li style="color:#7f1d1d">Has been compromised ' + Intl.NumberFormat().format(compromised) + ' times</li>'
    } else {
      response_html += '<li style="color:#064e3b">Should not be compromised</li>'
    }
  } catch (err) {
      response_html += '<li>' + err + '</li>'
  }

  response_html += '</ul>'
  return response_html
}
