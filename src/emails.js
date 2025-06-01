const { Client } = require("pg")
import { createEmailToken, readToken, usedToken } from "./tokens.js"

/**
 * Checks if an email address exists in the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} email_address - The email address to check.
 * @returns {Promise<object>} - An object with { success: true, exists: boolean } or { error: true, message: string }.
 */
export async function existsEmail(context, email_address) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const query = {
      text: "SELECT 1 FROM emails WHERE email_address = $1 LIMIT 1",
      values: [email_address],
    }
    const result = await client.query(query)
    return { success: true, exists: result.rowCount > 0 }
  } catch (error) {
    console.error("Error in existsEmail:", error)
    return {
      error: true,
      message: "Server error while checking email existence.",
      details: error.message,
    }
  } finally {
    await client.end()
  }
}

/**
 * Reads a single email record from the database by email address.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} email_address - The email address to look up.
 * @returns {Promise<object>} - An object with { success: true, email: record } or { success: false/error: true, message: string }.
 */
export async function readEmail(context, email_address) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const query = {
      text: "SELECT user_uuid, email_address, is_primary, is_verified, verified_at FROM emails WHERE email_address = $1 LIMIT 1",
      values: [email_address],
    }
    const result = await client.query(query)
    if (result.rows.length > 0) {
      return { success: true, email: result.rows[0] }
    } else {
      return { success: false, message: "Email not found." }
    }
  } catch (error) {
    console.error("Error in readEmail:", error)
    return {
      error: true,
      message: "Server error while reading email.",
      details: error.message,
    }
  } finally {
    await client.end()
  }
}

/**
 * Reads all email records for a given user from the database.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<Array<object>>} - An array of email objects or an empty array if none found.
 * @throws Will throw an error if the database query fails.
 */
export async function readEmails(context, user_uuid) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const query = {
      text: "SELECT email_address, is_primary, is_verified, verified_at FROM emails WHERE user_uuid = $1 ORDER BY is_primary DESC, verified_at ASC",
      values: [user_uuid],
    }
    const result = await client.query(query)
    return result.rows
  } catch (error) {
    console.error("Error in readEmails:", error)
    throw error // Re-throw the error to be handled by the caller
  } finally {
    await client.end()
  }
}

/**
 * Adds an email address for a user and optionally generates a verification token.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_address - The email address to add.
 * @param {boolean} is_primary - Whether this email should be the primary email.
 * @param {boolean} is_verified - Whether this email is already verified.
 * @returns {Promise<object>} - An object indicating success or failure, and token if generated.
 */
export async function createEmail(
  context,
  user_uuid,
  email_address,
  is_primary = false,
  is_verified = false
) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()

    // Check if the email already exists for this user
    const existingEmailResult = await readEmail(context, email_address)
    if (
      existingEmailResult.success &&
      existingEmailResult.email &&
      existingEmailResult.email.user_uuid === user_uuid
    ) {
      return {
        error: true,
        message: "This email address is already associated with your account.",
        status: 409,
      }
    }
    // If readEmail returned an error or the email belongs to another user,
    // we might still have a global collision, which the INSERT will catch.

    const insertEmailQuery = {
      text: "INSERT INTO emails (user_uuid, email_address, is_primary, is_verified, verified_at) VALUES ($1, $2, $3, $4, $5)",
      values: [
        user_uuid,
        email_address,
        is_primary,
        is_verified,
        is_verified ? new Date().toISOString() : null,
      ],
    }
    await client.query(insertEmailQuery)

    let token_value = null
    if (!is_verified) {
      const createTokenResult = await createEmailToken(
        context,
        user_uuid,
        email_address
      )

      if (createTokenResult.error) {
        console.error(
          "Failed to create verification token:",
          createTokenResult.message
        )
        return {
          error: true,
          message: "Email added, but failed to create verification token.",
          status: 500,
        }
      }
      console.log(
        `Verification token ${createTokenResult.token_value} generated for ${email_address}`
      )
      token_value = createTokenResult.token_value
    }

    return {
      success: true,
      email_address,
      is_primary,
      is_verified,
      token_value,
    }
  } catch (error) {
    console.error("Error in createEmail:", error)
    // PostgreSQL error code for unique_violation is '23505'
    if (
      error.code === "23505" &&
      error.constraint === "emails_user_uuid_email_address_key"
    ) {
      return {
        error: true,
        message: "This email address is already associated with your account.",
        status: 409,
      }
    }
    if (
      error.code === "23505" &&
      error.constraint === "emails_email_address_key"
    ) {
      // Assuming a global unique constraint on email_address
      return {
        error: true,
        message: "This email address is already in use by another account.",
        status: 409,
      }
    }
    throw error // Re-throw other errors to be handled by the caller
  } finally {
    if (client && client._connected) {
      // Ensure client is connected before ending
      await client.end()
    }
  }
}

/**
 * Verifies an email address using a token.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} token_value - The verification token.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function verifyEmailByToken(context, token_value) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  let tokenRecordFromRead

  try {
    // Use readToken to get general token details first
    const readTokenResult = await readToken(context, token_value)

    if (
      readTokenResult.error ||
      !readTokenResult.success ||
      !readTokenResult.token
    ) {
      console.error(
        "Error reading token in verifyEmailByToken:",
        readTokenResult.message
      )
      return { error: true, message: "Error verifying token.", status: 500 }
    }

    tokenRecordFromRead = readTokenResult.token
    const { user_uuid, email_address, expires_at, is_used } =
      tokenRecordFromRead

    if (is_used) {
      return {
        error: true,
        message: "Verification token has already been used.",
        status: 400,
      }
    }

    const now = new Date()
    const tokenExpiresAt = new Date(expires_at)

    if (now > tokenExpiresAt) {
      return {
        error: true,
        message: "Verification token expired.",
        status: 400,
      }
    }

    const verified_at = new Date().toISOString()

    // Use readEmail to get the email record
    const emailReadResult = await readEmail(context, email_address)

    if (
      emailReadResult.error ||
      !emailReadResult.success ||
      !emailReadResult.email
    ) {
      // Token is valid but email doesn't exist for user? Should be rare.
      // Or an error occurred reading the email.
      await usedToken(context, token_value)
      return {
        error: true,
        message:
          emailReadResult.message ||
          "Email address not found for this user, though token was valid.",
        status: emailReadResult.status || 404,
      }
    }

    const emailRecord = emailReadResult.email

    // Ensure the email from the token matches the user_uuid from the email record
    if (emailRecord.user_uuid !== user_uuid) {
      await usedToken(context, token_value)
      return {
        error: true,
        message: "Token-email mismatch with user account.",
        status: 400, // Bad request, token doesn't align with email's user
      }
    }

    if (emailRecord.is_verified) {
      // Email already verified, token is now redundant for this specific email.
      // Mark the token as used.
      await usedToken(context, token_value)
      return {
        success: true, // Or info: true
        message: "Email address already verified.",
        status: 200, // Or a different status like 202 if no action taken but accepted
      }
    }

    await client.connect()
    const updateEmailQuery = {
      text: "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3",
      values: [verified_at, user_uuid, email_address],
    }
    const updateEmailResult = await client.query(updateEmailQuery)

    if (updateEmailResult.rowCount === 0) {
      // This case should be rare if emailRecord was found earlier
      // Mark the token as used.
      await usedToken(context, token_value)
      return {
        error: true,
        message: "Failed to update email verification status.",
        status: 500,
      }
    }

    // Mark the token as used
    const usedTokenResult = await usedToken(context, token_value)
    if (!usedTokenResult.success) {
      // Log this, but proceed with verification as email is updated.
      console.warn(
        `Failed to mark token ${token_value} as used after verification, but email was verified.`
      )
    }

    return {
      success: true,
      message: "Email verified successfully.",
      user_uuid: user_uuid,
      email_address: email_address,
    }
  } catch (error) {
    console.error("Error in verifyEmailByToken:", error)
    return {
      error: true,
      message: "Server error during email verification.",
      status: 500,
    }
  } finally {
    if (client && client._connected) {
      await client.end()
    }
  }
}

/**
 * Sets an email address as the primary email for a user.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} new_primary_email - The email address to set as primary.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function setPrimaryEmail(context, user_uuid, new_primary_email) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    const emailReadResult = await readEmail(context, new_primary_email)

    if (
      emailReadResult.error ||
      !emailReadResult.success ||
      !emailReadResult.email
    ) {
      return {
        error: true,
        message: emailReadResult.message || "Email address not found.",
        status: emailReadResult.status || 404,
      }
    }

    const targetEmailRecord = emailReadResult.email

    if (targetEmailRecord.user_uuid !== user_uuid) {
      return {
        error: true,
        message: "This email address does not belong to your account.",
        status: 403, // Forbidden
      }
    }

    if (!targetEmailRecord.is_verified) {
      return {
        error: true,
        message:
          "This email address must be verified before it can be made primary.",
        status: 400,
      }
    }

    await client.connect()

    // Demote all current primary emails for this user
    await client.query(
      "UPDATE emails SET is_primary = FALSE WHERE user_uuid = $1 AND is_primary = TRUE",
      [user_uuid]
    )

    // Promote new primary
    const promoteResult = await client.query(
      "UPDATE emails SET is_primary = TRUE WHERE user_uuid = $1 AND email_address = $2",
      [user_uuid, new_primary_email]
    )

    if (promoteResult.rowCount > 0) {
      return {
        success: true,
        message: "Primary email changed successfully.",
        status: 200,
      }
    } else {
      // This case should ideally not be reached if FOR UPDATE lock worked and checks passed
      return {
        error: true,
        message: "Failed to change primary email due to an unexpected issue.",
        status: 500,
      }
    }
  } catch (error) {
    console.error("Error in setPrimaryEmail:", error)
    throw error
  } finally {
    await client.end()
  }
}

/**
 * Removes a non-primary email address for a user.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} email_to_remove - The email address to remove.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function deleteEmail(context, user_uuid, email_to_remove) {
  try {
    const emailReadResult = await readEmail(context, email_to_remove)

    if (
      emailReadResult.error ||
      !emailReadResult.success ||
      !emailReadResult.email
    ) {
      return {
        error: true,
        message: emailReadResult.message || "Email address not found.",
        status: emailReadResult.status || 404,
      }
    }

    const emailRecord = emailReadResult.email

    if (emailRecord.user_uuid !== user_uuid) {
      return {
        error: true,
        message: "This email address does not belong to your account.",
        status: 403,
      }
    }

    if (emailRecord.is_primary) {
      return {
        error: true,
        message:
          "Cannot remove the primary email address. Please set another email as primary first.",
        status: 400,
      }
    }

    // Perform the delete operation with a new client instance for this specific task
    const deleteClient = new Client(context.env.HYPERDRIVE.connectionString)
    try {
      await deleteClient.connect()
      const deleteResult = await deleteClient.query(
        "DELETE FROM emails WHERE user_uuid = $1 AND email_address = $2 AND is_primary = FALSE",
        [user_uuid, email_to_remove]
      )

      if (deleteResult.rowCount === 0) {
        // Should not happen if previous checks passed, unless race condition or already deleted
        return {
          error: true,
          message:
            "Failed to remove email. It might have been already removed or was primary.",
          status: 404, // Or 500 if unexpected
        }
      }
    } finally {
      if (deleteClient && deleteClient._connected) {
        await deleteClient.end()
      }
    }

    return {
      success: true,
      message: "Email address removed successfully.",
      status: 200,
    }
  } catch (error) {
    console.error("Error in deleteEmail:", error)
    throw error
  }
}
