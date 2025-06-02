const { Client } = require("pg")
const crypto = require("crypto")

// This module provides functions to manage tokens in a PostgreSQL database.
// Tokens can be used for various purposes such as email verification, password resets, etc.
// token_type can be 'email_verification' or 'password_reset' by default, but can be extended for other uses.
// SQL schema for tokens table: sql/tokens.sql

/**
 * Creates a new token in the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} token_type - The type of token (e.g., 'email_verification', 'password_reset').
 * @param {Date} expires_at - The expiration date and time for the token.
 * @param {string} [email_address] - (Optional) The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createToken(
  context,
  user_uuid,
  token_type,
  expires_at,
  email_address = null
) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const token_value = crypto.randomUUID()

    const query = {
      text: "INSERT INTO tokens (user_uuid, token_type, token_value, expires_at, email_address, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING token_value",
      values: [user_uuid, token_type, token_value, expires_at, email_address],
    }
    const result = await client.query(query)

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
  } finally {
    await client.end()
  }
}

/**
 * Reads a token from the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} token_value - The value of the token to read.
 * @returns {Promise<object|null>} - The token record if found and valid, null otherwise, or an error object.
 */
export async function readToken(context, token_value) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()

    let queryString =
      "SELECT user_uuid, email_address, token_type, expires_at, is_used FROM tokens WHERE token_value = $1"
    const queryParams = [token_value]

    const query = {
      text: queryString,
      values: queryParams,
    }
    const result = await client.query(query)

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
  } finally {
    await client.end()
  }
}

/**
 * Updates a token in the database, typically to mark it as used.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} token_value - The value of the token to update.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function usedToken(context, token_value) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()

    // For now, we only support updating is_used. This can be expanded later.
    const query = {
      text: "UPDATE tokens SET is_used = $1 WHERE token_value = $2",
      values: [true, token_value],
    }
    const result = await client.query(query)
    return { success: result.rowCount > 0, rowCount: result.rowCount }
  } catch (error) {
    console.error("Error in usedToken:", error)
    return {
      error: true,
      message: "Server error while updating token.",
      details: error.message,
    }
  } finally {
    await client.end()
  }
}

/**
 * Deletes tokens associated with a specific user and email address.
 * Can be expanded to delete by token_value or other criteria if needed.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} token_value - The token value for which to delete tokens.
 * @returns {Promise<object>} - An object indicating success (rowCount) or failure.
 */
export async function deleteToken(context, user_uuid, token_value) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    let queryString =
      "DELETE FROM tokens WHERE user_uuid = $1 AND token_value = $2"
    const queryParams = [user_uuid, token_value]

    const query = {
      text: queryString,
      values: queryParams,
    }
    const result = await client.query(query)
    return { success: true, rowCount: result.rowCount }
  } catch (error) {
    console.error("Error in deleteToken:", error)
    return {
      error: true,
      message: "Server error while deleting tokens.",
      details: error.message,
    }
  } finally {
    await client.end()
  }
}

/**
 * Creates a new email verification token in the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_address - The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createEmailToken(context, user_uuid, email_address) {
  try {
    const token_type = "email_verification"
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(
      context,
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
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createPasswordToken(context, user_uuid) {
  try {
    const token_type = "password_reset"
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    // Call createToken to insert the email token
    return await createToken(
      context,
      user_uuid,
      token_type,
      expires_at
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
