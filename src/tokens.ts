// This module provides functions to manage tokens in a PostgreSQL database.
// Tokens can be used for various purposes such as email verification, password resets, etc.
// token_type can be 'email_verification' or 'password_reset' by default, but can be extended for other uses.
// SQL schema for tokens table: sql/tokens.sql
//
// createToken + consumeToken are the recommended pair for any single-use-token
// flow: createToken issues the token, consumeToken atomically validates and
// spends it in one statement, so it is free of the readToken -> check -> usedToken
// TOCTOU race. readToken / usedToken / deleteToken are retained for the rarer
// cases that genuinely need a non-consuming read or an out-of-band delete.

/**
 * Creates a new token in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} token_type - The type of token (e.g., 'email_verification', 'password_reset').
 * @param {Date} expires_at - The expiration date and time for the token.
 * @param {string} [email_address] - (Optional) The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createToken(
  dbClient: DbClient,
  user_uuid: string,
  token_type: string,
  expires_at: string,
  email_address: string | null = null
): Promise<TokenEnvelope<{ token_value: string }>> {
  try {
    const token_value = crypto.randomUUID()

    const query = {
      text: "INSERT INTO tokens (user_uuid, token_type, token_value, expires_at, email_address, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING token_value",
      values: [user_uuid, token_type, token_value, expires_at, email_address],
    }
    const result = await dbClient.query(query)

    if (result.rows.length > 0) {
      return { success: true, token_value: token_value }
    } else {
      return { error: true, message: "Failed to create token." }
    }
  } catch (error) {
    console.error("Error in createToken:", error)
    // Consider specific error handling, e.g., for unique constraints if applicable
    return {
      error: true,
      message: "Server error while creating token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Reads a token from the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} token_value - The value of the token to read.
 * @returns {Promise<object|null>} - The token record if found and valid, null otherwise, or an error object.
 */
export async function readToken(
  dbClient: DbClient,
  token_value: string
): Promise<TokenEnvelope<{ token: TokenRow }>> {
  try {
    let queryString =
      "SELECT user_uuid, email_address, token_type, expires_at, is_used FROM tokens WHERE token_value = $1"
    const queryParams = [token_value]

    const query = {
      text: queryString,
      values: queryParams,
    }
    const result = await dbClient.query(query)

    if (result.rows.length > 0) {
      return { success: true, token: result.rows[0] }
    } else {
      return { error: true, message: "Token not found." }
    }
  } catch (error) {
    console.error("Error in readToken:", error)
    return {
      error: true,
      message: "Server error while reading token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Updates a token in the database, typically to mark it as used.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} token_value - The value of the token to update.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function usedToken(
  dbClient: DbClient,
  token_value: string
): Promise<
  | { success: boolean; error?: never; rowCount: number }
  | { success?: never; error: true; message: string; details?: unknown }
> {
  try {
    // For now, we only support updating is_used. This can be expanded later.
    const query = {
      text: "UPDATE tokens SET is_used = $1 WHERE token_value = $2",
      values: [true, token_value],
    }
    const result = await dbClient.query(query)
    return {
      success: (result.rowCount ?? 0) > 0,
      rowCount: result.rowCount ?? 0,
    }
  } catch (error) {
    console.error("Error in usedToken:", error)
    return {
      error: true,
      message: "Server error while updating token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Atomically consumes a single-use token: marks it used and returns its
 * record in one statement. This is the TOCTOU-safe replacement for the
 * readToken -> check is_used -> usedToken sequence — concurrent requests with
 * the same token cannot both succeed, because only one UPDATE can match the
 * `is_used = FALSE` predicate.
 *
 * A `rowCount === 0` result collapses every failure mode — missing, wrong
 * type, expired, or already used — into one "invalid token" outcome.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} token_value - The value of the token to consume.
 * @param {string} expected_type - The token_type the caller requires.
 * @returns {Promise<object>} - { success: true, token } on success, or an error object.
 */
export async function consumeToken(
  dbClient: DbClient,
  token_value: string,
  expected_type: string
): Promise<TokenEnvelope<{ token: TokenRow }>> {
  try {
    const query = {
      text: "UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2 AND is_used = FALSE AND expires_at > NOW() RETURNING user_uuid, email_address, token_type, expires_at, is_used",
      values: [token_value, expected_type],
    }
    const result = await dbClient.query(query)

    if (result.rows.length > 0) {
      return { success: true, token: result.rows[0] }
    } else {
      return {
        error: true,
        message: "Invalid, expired, or already-used token.",
      }
    }
  } catch (error) {
    console.error("Error in consumeToken:", error)
    return {
      error: true,
      message: "Server error while consuming token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Deletes tokens associated with a specific user and email address.
 * Can be expanded to delete by token_value or other criteria if needed.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} token_value - The token value for which to delete tokens.
 * @returns {Promise<object>} - An object indicating success (rowCount) or failure.
 */
export async function deleteToken(
  dbClient: DbClient,
  user_uuid: string,
  token_value: string
): Promise<
  | { success: true; error?: never; rowCount: number }
  | { success?: never; error: true; message: string; details?: unknown }
> {
  try {
    let queryString =
      "DELETE FROM tokens WHERE user_uuid = $1 AND token_value = $2"
    const queryParams = [user_uuid, token_value]

    const query = {
      text: queryString,
      values: queryParams,
    }
    const result = await dbClient.query(query)
    return { success: true, rowCount: result.rowCount ?? 0 }
  } catch (error) {
    console.error("Error in deleteToken:", error)
    return {
      error: true,
      message: "Server error while deleting tokens.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Creates a new email verification token in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_address - The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createEmailToken(
  dbClient: DbClient,
  user_uuid: string,
  email_address: string
): Promise<TokenEnvelope<{ token_value: string }>> {
  try {
    const token_type = "email_verification"
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(
      dbClient,
      user_uuid,
      token_type,
      expires_at,
      email_address
    )
  } catch (error) {
    console.error("Error in createEmailToken:", error)
    return {
      error: true,
      message: "Server error while creating email token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Creates a new password reset token in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_address - The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createPasswordToken(
  dbClient: DbClient,
  user_uuid: string,
  email_address: string
): Promise<TokenEnvelope<{ token_value: string }>> {
  try {
    const token_type = "password_reset"
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(
      dbClient,
      user_uuid,
      token_type,
      expires_at,
      email_address
    )
  } catch (error) {
    console.error("Error in createPasswordToken:", error)
    return {
      error: true,
      message: "Server error while creating password token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Creates a new login token in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createLoginToken(
  dbClient: DbClient,
  user_uuid: string
): Promise<TokenEnvelope<{ token_value: string }>> {
  try {
    const token_type = "totp_verification_pending"
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(dbClient, user_uuid, token_type, expires_at)
  } catch (error) {
    console.error("Error in createLoginToken:", error)
    return {
      error: true,
      message: "Server error while creating login token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Creates a new sudo token in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createSudoToken(
  dbClient: DbClient,
  user_uuid: string
): Promise<TokenEnvelope<{ token_value: string }>> {
  try {
    const token_type = "sudo_elevation"
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(dbClient, user_uuid, token_type, expires_at)
  } catch (error) {
    console.error("Error in createSudoToken:", error)
    return {
      error: true,
      message: "Server error while creating sudo token.",
      details: error instanceof Error ? error.message : String(error),
    }
  }
}
