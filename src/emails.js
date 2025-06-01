const { Client } = require("pg")
import { createToken, readToken, updateToken, deleteToken } from "./tokens.js"

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
    const existingEmailQuery = {
      text: "SELECT email_address FROM emails WHERE user_uuid = $1 AND email_address = $2",
      values: [user_uuid, email_address],
    }
    const existingEmailResult = await client.query(existingEmailQuery)
    if (existingEmailResult.rowCount > 0) {
      return {
        error: true,
        message: "This email address is already associated with your account.",
        status: 409,
      }
    }

    // Check if the email exists for ANY user (if we are adding a new one, it shouldn't be globally unique yet unless it's an error)
    // This check is more relevant for the API endpoint calling this, to give a generic "email in use"
    // but for internal logic, we primarily care about *this* user.
    // For now, let's assume the calling API does the global check if needed.

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
      const token_expires_at = new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString() // 24 hours
      const token_type = is_primary
        ? "email_verification"
        : "backup_email_verification"

      const createTokenResult = await createToken(
        context,
        user_uuid,
        token_type,
        token_expires_at,
        email_address
      )

      if (createTokenResult.error) {
        // Handle token creation error - potentially rollback email insertion or log critical error
        console.error(
          "Failed to create verification token:",
          createTokenResult.message
        )
        // Depending on desired atomicity, you might want to throw an error here
        // or return an error state that indicates partial success (email added, token failed)
        return {
          error: true,
          message: "Email added, but failed to create verification token.",
          status: 500,
        }
      }
      console.log(
        `Verification token ${createTokenResult.token_value} generated for ${email_address} (type: ${token_type})`
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
    await client.end()
  }
}

/**
 * Verifies an email address using a token.
 * @param {object} context - The Cloudflare Pages context object.
 * @param {string} tokenValue - The verification token.
 * @returns {Promise<object>} - An object indicating success or failure.
 */
export async function verifyEmailByToken(context, tokenValue) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  let tokenRecordFromRead

  try {
    await client.connect()

    const readTokenResult = await readToken(context, tokenValue, [
      "email_verification",
      "backup_email_verification",
    ])

    if (readTokenResult.error) {
      console.error(
        "Error reading token in verifyEmailByToken:",
        readTokenResult.message
      )
      return { error: true, message: "Error verifying token.", status: 500 }
    }

    if (!readTokenResult.success || !readTokenResult.token) {
      return {
        error: true,
        message: "Invalid, expired, or already used verification token.",
        status: 400,
      }
    }

    tokenRecordFromRead = readTokenResult.token
    const { user_uuid, email_address, token_type, expires_at, is_used } =
      tokenRecordFromRead

    if (is_used) {
      return {
        error: true,
        message: "Invalid, expired, or already used verification token.",
        status: 400,
      }
    }

    const now = new Date()
    const tokenExpiresAt = new Date(expires_at)

    if (now > tokenExpiresAt) {
      await updateToken(context, tokenValue, token_type, { is_used: true })
      return {
        error: true,
        message: "Verification token expired.",
        status: 400,
      }
    }

    const verified_at = new Date().toISOString()

    // Check if email exists and if it needs verification for the given type
    const emailCheckQuery = {
      text: "SELECT is_verified, is_primary FROM emails WHERE user_uuid = $1 AND email_address = $2",
      values: [user_uuid, email_address],
    }
    const emailCheckResult = await client.query(emailCheckQuery)
    const emailRecord = emailCheckResult.rows[0]

    if (!emailRecord) {
      await updateToken(context, tokenValue, token_type, { is_used: true })
      return {
        error: true,
        message: "Associated email record not found.",
        status: 404,
      }
    }

    if (emailRecord.is_verified) {
      // If it's already verified, and it's a backup email token for a non-primary email, or primary for primary, it's fine.
      // If it's a backup_email_verification token but the email is_primary, that's an inconsistent state.
      if (
        token_type === "backup_email_verification" &&
        emailRecord.is_primary
      ) {
        await updateToken(context, tokenValue, token_type, { is_used: true })
        return {
          error: true,
          message: "Cannot verify a primary email with a backup email token.",
          status: 400,
        }
      }
      await updateToken(context, tokenValue, token_type, { is_used: true })
      const message =
        token_type === "email_verification"
          ? "This email is already verified."
          : "This backup email is already verified."
      return { success: true, message: message, status: 200 }
    }

    // Proceed with verification
    let updateEmailResult
    if (token_type === "email_verification") {
      // Typically for primary email registration
      updateEmailResult = await client.query(
        "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3",
        [verified_at, user_uuid, email_address]
      )
    } else if (token_type === "backup_email_verification") {
      // For backup emails
      if (emailRecord.is_primary) {
        // Should not verify a primary email with a backup token if it wasn't verified before
        await updateToken(context, tokenValue, token_type, { is_used: true })
        return {
          error: true,
          message:
            "Cannot verify a primary email with a backup email token if it is not yet verified.",
          status: 400,
        }
      }
      updateEmailResult = await client.query(
        "UPDATE emails SET is_verified = TRUE, verified_at = $1 WHERE user_uuid = $2 AND email_address = $3 AND is_primary = FALSE",
        [verified_at, user_uuid, email_address]
      )
    } else {
      // Should not happen due to the initial query filter
      return { error: true, message: "Invalid token type.", status: 500 }
    }

    if (updateEmailResult.rowCount === 0) {
      await updateToken(context, tokenValue, token_type, { is_used: true })
      return {
        error: true,
        message:
          "Failed to verify email. Conditions not met or email not found.",
        status: 500,
      }
    }

    await updateToken(context, tokenValue, token_type, { is_used: true })

    const successMessage =
      token_type === "email_verification"
        ? "Email verified successfully."
        : "Backup email verified successfully."
    return { success: true, message: successMessage, status: 200 }
  } catch (error) {
    console.error("Error in verifyEmailByToken:", error)
    // Attempt to invalidate token on generic error if possible
    if (
      tokenValue &&
      tokenRecordFromRead && // Use the record obtained from readToken
      tokenRecordFromRead.token_type
    ) {
      try {
        // Use updateToken to invalidate
        await updateToken(context, tokenValue, tokenRecordFromRead.token_type, {
          is_used: true,
        })
      } catch (invalidationError) {
        console.error(
          "Failed to invalidate token during error handling in verifyEmailByToken:",
          invalidationError
        )
      }
    }
    throw error
  } finally {
    await client.end()
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
    await client.connect()
    await client.query("BEGIN")

    const targetEmailQuery = {
      text: "SELECT is_verified, is_primary FROM emails WHERE user_uuid = $1 AND email_address = $2 FOR UPDATE",
      values: [user_uuid, new_primary_email],
    }
    const targetEmailResult = await client.query(targetEmailQuery)
    const targetEmailRecord = targetEmailResult.rows[0]

    if (!targetEmailRecord) {
      await client.query("ROLLBACK")
      return {
        error: true,
        message: "Email address not found for this account.",
        status: 404,
      }
    }

    if (!targetEmailRecord.is_verified) {
      await client.query("ROLLBACK")
      return {
        error: true,
        message:
          "This email address must be verified before it can be made primary.",
        status: 400,
      }
    }

    if (targetEmailRecord.is_primary) {
      await client.query("ROLLBACK")
      return {
        success: true,
        message: "This email address is already your primary email.",
        status: 200,
      } // Not an error
    }

    // Demote current primary
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
      await client.query("COMMIT")
      return {
        success: true,
        message: "Primary email changed successfully.",
        status: 200,
      }
    } else {
      await client.query("ROLLBACK")
      // This case should ideally not be reached if FOR UPDATE lock worked and checks passed
      return {
        error: true,
        message: "Failed to change primary email due to an unexpected issue.",
        status: 500,
      }
    }
  } catch (error) {
    if (client && client._connected) {
      try {
        await client.query("ROLLBACK")
      } catch (rbError) {
        console.error("Error rolling back transaction:", rbError)
      }
    }
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
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()

    const emailCheckQuery = {
      text: "SELECT is_primary FROM emails WHERE user_uuid = $1 AND email_address = $2",
      values: [user_uuid, email_to_remove],
    }
    const emailCheckResult = await client.query(emailCheckQuery)

    if (emailCheckResult.rows.length === 0) {
      return {
        error: true,
        message: "Email address not found for this user.",
        status: 404,
      }
    }

    if (emailCheckResult.rows[0].is_primary) {
      return {
        error: true,
        message:
          "Cannot remove the primary email address. Please set another email as primary first.",
        status: 400,
      }
    }

    // Also delete any associated tokens for this email
    const deleteTokenResult = await deleteToken(
      context,
      user_uuid,
      email_to_remove
    )
    if (deleteTokenResult.error) {
      // Log or handle error if token deletion fails, but proceed with email removal
      console.error(
        "Error deleting tokens for email:",
        email_to_remove,
        deleteTokenResult.message
      )
    } else {
      console.log(
        `Deleted ${deleteTokenResult.rowCount} tokens for email: ${email_to_remove}`
      )
    }

    const deleteResult = await client.query(
      "DELETE FROM emails WHERE user_uuid = $1 AND email_address = $2 AND is_primary = FALSE",
      [user_uuid, email_to_remove]
    )

    if (deleteResult.rowCount === 0) {
      // Should not happen if previous checks passed, unless race condition or already deleted
      return {
        error: true,
        message:
          "Failed to remove email. It might have been already removed or was primary.",
        status: 404,
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
  } finally {
    await client.end()
  }
}

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
