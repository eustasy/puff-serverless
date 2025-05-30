import {
  puff_hashing_sha1_hibp,
  puff_hashing_password,
} from "./utilities_hashing.js"

/**
 * Verifies a user's password against the stored hash in the database.
 * @param {*} context - The context object containing environment variables and other configurations.
 * @param {*} pw - The plain text password to verify.
 * @param {*} user_uuid - The UUID of the user to verify the password for.
 * @returns {boolean} True if the password is verified, false otherwise.
 */
export async function password_verify(context, pw, user_uuid) {
  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()
    // Get the user\'s password hash and salt from the database
    const query = `
      SELECT secret_value
      FROM secrets
      WHERE user_uuid = $1 AND secret_type = \'puff_password_sha-384\'
      LIMIT 1
    `
    const result = await client.query(query, [user_uuid])

    if (result.rows.length === 0) {
      // It\'s generally better not to reveal if the user exists or not for password verification.
      // However, the original code threw "User password record not found".
      // For security, returning false (as if password didn\'t match) is often preferred.
      // Let\'s stick to a generic false for failed verification if no record.
      return false
    }
    const { secret_value } = result.rows[0]
    // Split the secret_value into the actual hash and salt
    const [actual_hash, salt] = secret_value.split(":")

    if (!actual_hash || !salt) {
      // Invalid format in DB
      console.error(`Invalid secret_value format for user_uuid: ${user_uuid}`)
      return false
    }

    const { hash: attempted_hash } = await puff_hashing_password(pw, salt)
    return attempted_hash === actual_hash
  } catch (error) {
    console.error("Error during password verification:", error)
    // In case of a system error, rethrow or return false depending on policy
    // Rethrowing might be better for higher-level error handling to log and respond appropriately
    throw error
  } finally {
    await client.end()
  }
}

/**
 * Checks if a password meets the requirements for length, number, and special characters.
 * @param {string} pw - The password to check.
 * @returns {boolean} True if the password meets all requirements, false otherwise.
 */
export async function password_requirements(pw) {
  var result = true
  if (pw.length < 12) {
    result = false
  }
  var hasNumber = /\d/
  if (!hasNumber.test(pw)) {
    result = false
  }
  var hasSpecial = /[!-\/:-@[-`{-~]/
  if (!hasSpecial.test(pw)) {
    result = false
  }
  return result
}

/**
 * Checks if a password meets the requirements for length, number, and special characters.
 * @param {string} pw - The password to check.
 * @returns {string} HTML string with the results of the password requirements check.
 */
export async function password_requirements_html(pw) {
  var response_html = "<h3>Password Requirements</h3><ul>"

  if (pw.length >= 12) {
    response_html +=
      '<li class="result-positive"><strong>Must</strong> be at least 12 characters long</li>'
  } else {
    response_html +=
      '<li class="result-negative"><strong>Must</strong> be at least 12 characters long</li>'
  }

  var hasNumber = /\d/
  // TODO Test these assertions:
  //hasNumber.test("ABC33SDF");  // true
  //hasNumber.test("ABCSDF");  // false
  if (hasNumber.test(pw)) {
    response_html += '<li class="result-positive">Should contain a number</li>'
  } else {
    response_html += '<li class="result-negative">Should contain a number</li>'
  }

  var hasSpecial = /[^a-zA-Z\d]/
  if (hasSpecial.test(pw)) {
    response_html +=
      '<li class="result-positive">Should contain a special character</li>'
  } else {
    response_html +=
      '<li class="result-negative">Should contain a special character</li>'
  }

  var pw_sha1 = await puff_hashing_sha1_hibp(pw)
  //response_html += '<li>' + pw_sha1.f5 + ' : ' + pw_sha1.l35 + '</li>'
  try {
    var compromised = 0
    await fetch("https://api.pwnedpasswords.com/range/" + pw_sha1.f5)
      .then((response) => response.text())
      .then((text) => {
        //response_html += '<li>' + text + '</li>'
        var inputArray = text.split("\n")
        // TODO Minor perf improvement: This for loop always runs the full length, but if we wrap it in a non-exported function we can `return` when we find a match.
        for (var i = 0; i < inputArray.length; i++) {
          let line_f35 = inputArray[i].slice(0, 35)
          let line_ln = inputArray[i].substring(36)
          //response_html += '<li>' + i + ' : ' + line_f35 + ' : ' + line_ln + '</li>'
          if (line_f35 == pw_sha1.l35.toUpperCase()) {
            compromised = parseInt(line_ln)
          }
        }
      })

    if (compromised > 0) {
      response_html +=
        '<li class="result-negative">Has been compromised ' +
        Intl.NumberFormat().format(compromised) +
        " times</li>"
    } else {
      response_html +=
        '<li class="result-positive">Should not be compromised</li>'
    }
  } catch (err) {
    response_html += "<li>" + err + "</li>"
  }

  response_html += "</ul>"
  return response_html
}
