import {
  puff_hashing_sha1_hibp,
  puff_hashing_password,
} from "./utilities/hashing.js"

/**
 * Creates a new password hash for a user and stores it in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} password - The plain text password.
 * @returns {Promise<boolean>} True if the password was created successfully, false otherwise.
 */
export async function createPassword(dbClient, user_uuid, password) {
  try {
    // Validate password requirements
    const isValid = password_requirements(password)
    if (!isValid) {
      return {
        success: false,
        message: "Password does not meet the required criteria.",
        status: 400,
      }
    }
    // Hash the password
    const { hash, salt, algo } = await puff_hashing_password(password)
    const secret_value = `${hash}:${salt}`
    const current_secret_type = `puff_password_${algo}`

    const secret_uuid = crypto.randomUUID()

    const query = `
      INSERT INTO secrets (secret_uuid, user_uuid, secret_type, secret_value, is_enabled)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING user_uuid;
    `
    const result = await dbClient.query(query, [
      secret_uuid,
      user_uuid,
      current_secret_type,
      secret_value,
    ])
    if (result.rows.length > 0) {
      return { success: true, status: 200 }
    }
    return {
      error: true,
      message: "Password creation returned no rows.",
      status: 500,
    }
  } catch (error) {
    console.error("Error in createPassword:", error)
    return {
      error: true,
      message: "Could not create password.",
      details: error.message,
      status: 500,
    }
  }
}

/**
 * Reads a user's active password hash, salt, and algorithm from the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} Envelope: `{ success: true, secret_value, algo, status: 200 }` on hit, `{ success: false, message, status: 404 }` on miss, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function readPassword(dbClient, user_uuid) {
  try {
    const query = `
      SELECT secret_value, secret_type
      FROM secrets
      WHERE user_uuid = $1 AND secret_type LIKE 'puff_password_%' AND is_enabled = TRUE
      LIMIT 1;
    `
    const result = await dbClient.query(query, [user_uuid])
    if (result.rows.length === 0) {
      return {
        success: false,
        message: "No active password found.",
        status: 404,
      }
    }
    const { secret_value, secret_type } = result.rows[0]
    const algo = secret_type.replace("puff_password_", "")

    // Update secret_last_used
    const updateQuery = `
      UPDATE secrets
      SET secret_last_used = CURRENT_TIMESTAMP
      WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE;
    `
    // Fire and forget is acceptable here as it's not critical for the read operation's success
    dbClient.query(updateQuery, [user_uuid, secret_type]).catch(console.error)

    return { success: true, secret_value, algo, status: 200 }
  } catch (error) {
    console.error("Error reading password:", error)
    return {
      error: true,
      message: "Could not read password.",
      details: error.message,
      status: 500,
    }
  }
}

/**
 * Disables all active 'puff_password_%' type secrets for a user.
 * Sets is_enabled to FALSE and updates secret_last_used.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<boolean>} True if any active password was found and disabled, false otherwise.
 */
export async function disablePassword(dbClient, user_uuid) {
  try {
    const query = `
      UPDATE secrets
      SET is_enabled = FALSE
      WHERE user_uuid = $1 AND secret_type LIKE 'puff_password_%' AND is_enabled = TRUE
      RETURNING user_uuid;
    `
    const result = await dbClient.query(query, [user_uuid])
    return {
      success: true,
      disabled: result.rows.length > 0,
      status: 200,
    }
  } catch (error) {
    console.error("Error in disablePassword:", error)
    return {
      error: true,
      message: "Could not disable password.",
      details: error.message,
      status: 500,
    }
  }
}

/**
 * Updates a user's password by disabling all old 'puff_password_%' type secrets and creating a new one.
 * This preserves the old password records with is_enabled = FALSE.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} newPassword - The new plain text password.
 * @returns {Promise<boolean>} True if the new password was created successfully.
 */
export async function updatePassword(dbClient, user_uuid, newPassword) {
  try {
    // Atomic disable-then-create so a failure between the two doesn't leave
    // the user with no enabled password.
    await dbClient.query("BEGIN")
    try {
      const disableResult = await disablePassword(dbClient, user_uuid)
      if (disableResult.error) {
        await dbClient.query("ROLLBACK").catch(() => {})
        return disableResult
      }
      const createResult = await createPassword(
        dbClient,
        user_uuid,
        newPassword
      )
      if (createResult.error || !createResult.success) {
        // Propagate the inner envelope: validation failures keep their 400,
        // DB errors keep their 500. Either way roll back the disable.
        await dbClient.query("ROLLBACK").catch(() => {})
        return createResult
      }
      await dbClient.query("COMMIT")
      return { success: true, status: 200 }
    } catch (txError) {
      await dbClient.query("ROLLBACK").catch(() => {})
      return {
        error: true,
        message: "Could not update password.",
        details: txError.message,
        status: 500,
      }
    }
  } catch (error) {
    console.error("Error in updatePassword:", error)
    return {
      error: true,
      message: "Could not update password.",
      details: error.message,
      status: 500,
    }
  }
}

/**
 * Verifies a user's password against the stored hash in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to verify the password for.
 * @param {string} pw - The plain text password to verify.
 * @returns {boolean} True if the password is verified, false otherwise.
 */
export async function password_verify(dbClient, user_uuid, pw) {
  try {
    const passwordResult = await readPassword(dbClient, user_uuid)

    if (passwordResult.error) {
      // DB error reading password — propagate to outer catch.
      throw new Error(passwordResult.message)
    }

    if (!passwordResult.success) {
      // No active password found for the user.
      console.warn(
        `Password verification failed: No active password found for user_uuid ${user_uuid}`
      )
      return false
    }

    const { secret_value, algo } = passwordResult
    const [actual_hash, salt] = secret_value.split(":")

    const { hash: attempted_hash } = await puff_hashing_password(pw, salt, algo)

    return attempted_hash === actual_hash
  } catch (error) {
    console.error("Error during password verification:", error)
    // In case of a system error, rethrow or return false depending on policy
    // Rethrowing might be better for higher-level error handling to log and respond appropriately
    throw error
  }
}

/**
 * Checks if a password meets the requirements for length, number, and special characters.
 * @param {string} pw - The password to check.
 * @returns {boolean} True if the password meets all requirements, false otherwise.
 */
export function password_requirements(pw) {
  var result = true
  if (pw.length < 12) {
    result = false
  }
  //var hasNumber = /\d/
  //if (!hasNumber.test(pw)) {
  //  result = false
  //}
  //var hasSpecial = /[!-\/:-@[-`{-~]/
  //if (!hasSpecial.test(pw)) {
  //  result = false
  //}
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
    const response = await fetch(
      "https://api.pwnedpasswords.com/range/" + pw_sha1.f5
    )
    const text = await response.text()
    //response_html += '<li>' + text + '</li>'
    var inputArray = text.split("\n")
    for (var i = 0; i < inputArray.length; i++) {
      let line_f35 = inputArray[i].slice(0, 35)
      let line_ln = inputArray[i].substring(36)
      //response_html += '<li>' + i + ' : ' + line_f35 + ' : ' + line_ln + '</li>'
      if (line_f35 == pw_sha1.l35.toUpperCase()) {
        compromised = parseInt(line_ln)
        break
      }
    }

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
