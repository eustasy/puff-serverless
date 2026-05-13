// This module provides functions to manage tokens in a PostgreSQL database.
// Tokens can be used for various purposes such as email verification, password resets, etc.
// token_type can be 'email_verification' or 'password_reset' by default, but can be extended for other uses.
// SQL schema for tokens table: sql/tokens.sql

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
  dbClient,
  user_uuid,
  token_type,
  expires_at,
  email_address = null
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
      details: error.message,
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
  dbClient,
  token_value
): Promise<TokenEnvelope<{ token: any }>> {
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
      details: error.message,
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
  dbClient,
  token_value
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
    return { success: result.rowCount > 0, rowCount: result.rowCount }
  } catch (error) {
    console.error("Error in usedToken:", error)
    return {
      error: true,
      message: "Server error while updating token.",
      details: error.message,
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
  dbClient,
  user_uuid,
  token_value
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
    return { success: true, rowCount: result.rowCount }
  } catch (error) {
    console.error("Error in deleteToken:", error)
    return {
      error: true,
      message: "Server error while deleting tokens.",
      details: error.message,
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
  dbClient,
  user_uuid,
  email_address
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
      details: error.message,
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
  dbClient,
  user_uuid,
  email_address
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
      details: error.message,
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
  dbClient,
  user_uuid
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
      details: error.message,
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
  dbClient,
  user_uuid
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
      details: error.message,
    }
  }
}
