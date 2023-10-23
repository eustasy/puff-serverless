export async function pwcheck(pw) {
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
