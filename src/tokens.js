const { Client } = require("pg");
const crypto = require("crypto");

/**
 * Creates a new token in the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} token_type - The type of token (e.g., 'email_verification', 'password_reset').
 * @param {Date} expires_at - The expiration date and time for the token.
 * @param {string} [email_address] - (Optional) The email address associated with this token.
 * @returns {Promise<object>} - An object with the token_value if successful, or an error object.
 */
export async function createToken(context, user_uuid, token_type, expires_at, email_address = null) {
  const client = new Client(context.env.HYPERDRIVE.connectionString);
  try {
    await client.connect();
    const token_value = crypto.randomUUID();

    const query = {
      text: "INSERT INTO tokens (user_uuid, token_type, token_value, expires_at, email_address, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING token_value",
      values: [user_uuid, token_type, token_value, expires_at, email_address],
    };
    const result = await client.query(query);

    if (result.rows.length > 0) {
      return { success: true, token_value: result.rows[0].token_value };
    } else {
      return { error: true, message: "Failed to create token." };
    }
  } catch (error) {
    console.error("Error in createToken:", error);
    // Consider specific error handling, e.g., for unique constraints if applicable
    return { error: true, message: "Server error while creating token.", details: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Reads a token from the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} tokenValue - The value of the token to read.
 * @param {string[]} expected_token_types - An array of expected token types.
 * @returns {Promise<object|null>} - The token record if found and valid, null otherwise, or an error object.
 */
export async function readToken(context, tokenValue, expected_token_types = []) {
  const client = new Client(context.env.HYPERDRIVE.connectionString);
  try {
    await client.connect();
    // Ensure expected_token_types is an array
    const types = Array.isArray(expected_token_types) ? expected_token_types : [expected_token_types].filter(t => t);

    let queryString = "SELECT user_uuid, email_address, token_type, expires_at, is_used FROM tokens WHERE token_value = $1";
    const queryParams = [tokenValue];

    if (types.length > 0) {
      queryString += " AND token_type = ANY($2::text[])"; // Use ANY for array comparison
      queryParams.push(types);
    }

    const query = {
      text: queryString,
      values: queryParams,
    };
    const result = await client.query(query);

    if (result.rows.length > 0) {
      return { success: true, token: result.rows[0] };
    } else {
      return { success: false, message: "Token not found or type mismatch." }; // Distinguish from error
    }
  } catch (error) {
    console.error("Error in readToken:", error);
    return { error: true, message: "Server error while reading token.", details: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Updates a token in the database, typically to mark it as used.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} tokenValue - The value of the token to update.
 * @param {string} token_type - The specific type of the token being updated (for precise targeting).
 * @param {object} updates - An object containing fields to update, e.g., { is_used: true }.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function updateToken(context, tokenValue, token_type, updates) {
  const client = new Client(context.env.HYPERDRIVE.connectionString);
  try {
    await client.connect();

    // For now, we only support updating is_used. This can be expanded later.
    if (updates.hasOwnProperty('is_used')) {
      const query = {
        text: "UPDATE tokens SET is_used = $1 WHERE token_value = $2 AND token_type = $3",
        values: [updates.is_used, tokenValue, token_type],
      };
      const result = await client.query(query);
      return { success: result.rowCount > 0, rowCount: result.rowCount };
    } else {
      return { error: true, message: "No valid fields provided for update." };
    }
  } catch (error) {
    console.error("Error in updateToken:", error);
    return { error: true, message: "Server error while updating token.", details: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Deletes tokens associated with a specific user and email address.
 * Can be expanded to delete by token_value or other criteria if needed.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_address - The email address for which to delete tokens.
 * @param {string} [token_type] - (Optional) Specific token type to delete.
 * @returns {Promise<object>} - An object indicating success (rowCount) or failure.
 */
export async function deleteToken(context, user_uuid, email_address, token_type = null) {
  const client = new Client(context.env.HYPERDRIVE.connectionString);
  try {
    await client.connect();
    let queryString = "DELETE FROM tokens WHERE user_uuid = $1 AND email_address = $2";
    const queryParams = [user_uuid, email_address];

    if (token_type) {
      queryString += " AND token_type = $3";
      queryParams.push(token_type);
    }

    const query = {
      text: queryString,
      values: queryParams,
    };
    const result = await client.query(query);
    return { success: true, rowCount: result.rowCount };
  } catch (error) {
    console.error("Error in deleteToken:", error);
    return { error: true, message: "Server error while deleting tokens.", details: error.message };
  } finally {
    await client.end();
  }
}
