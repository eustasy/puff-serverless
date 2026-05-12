import { createSession } from "./sessions.js"
import { createEmail, existsEmail, readEmail } from "./emails.js"
import { createPassword, password_verify } from "./passwords.js"
import { has2fa } from "./2fa.js"

/**
 * Retrieves a user's details by their UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object|null>} - The user object if found and active, null otherwise.
 */
export async function readUser(dbClient, user_uuid) {
  try {
    const query =
      "SELECT user_uuid, user_name, user_created_at, user_last_login FROM users WHERE user_uuid = $1 AND user_active = TRUE LIMIT 1"
    const result = await dbClient.query(query, [user_uuid])
    if (result.rows.length > 0) {
      return result.rows[0]
    }
    return null
  } catch (error) {
    console.error("Error in readUser:", error)
    throw error // Rethrow to be handled by caller
  }
}

export async function user_register(dbClient, name, email, password) {
  try {
    // Step 0. Check if the email already exists using existsEmail
    const emailCheck = await existsEmail(dbClient, email)
    if (emailCheck.error) {
      console.error("Error checking email existence:", emailCheck.message)
      throw new Error("Failed to verify email existence during registration.")
    }
    if (emailCheck.exists) {
      throw new Error("Email is already registered.")
    }

    // Step 1. Register the user
    const uuid = crypto.randomUUID()
    await dbClient.query(
      "INSERT INTO users (user_uuid, user_name) VALUES ($1, $2)",
      [uuid, name]
    )

    // Step 2. Register the email using createEmail function
    // createEmail will handle token generation internally
    const createEmailResult = await createEmail(
      dbClient,
      uuid,
      email,
      true,
      false
    ) // true for is_primary, false for is_verified initially
    if (createEmailResult.error) {
      // If createEmail itself had an issue (e.g. unique constraint within its own logic if user already had it - though less likely here)
      // This part might need more robust error handling depending on how createEmail signals errors.
      // For now, re-throwing a generic error or createEmailResult.message
      throw new Error(
        createEmailResult.message ||
          "Failed to add primary email during registration."
      )
    }
    // Log the verification link using the token from createEmailResult
    if (createEmailResult.token_value) {
      // TODO Wait for email messaging to be implemented
      console.log(
        `Verification link: /api/email/verify?token=${createEmailResult.token_value}`
      )
    }

    // Step 3. Register the password using createPassword
    const passwordCreated = await createPassword(dbClient, uuid, password)
    if (!passwordCreated) {
      // This case implies an issue within createPassword, like a DB error it couldn't handle.
      // createPassword itself throws an error on failure, so this might be redundant if not caught and returned as false.
      // However, if createPassword is modified to return false on specific logical failures (not just DB exceptions), this check is useful.
      throw new Error("Failed to create password during registration.")
    }

    return { success: true, user_uuid: uuid, email: email }
  } catch (error) {
    console.error("Error during user registration:", error)
    // Propagate the error or return a structured error response
    throw error // Or return { error: true, message: error.message }
  }
}

export async function user_login(
  dbClient,
  email,
  password,
  user_agent,
  ip_address,
  ip_country
) {
  try {
    const emailReadResult = await readEmail(dbClient, email)

    // Handle cases where readEmail indicates an error, email not found, or unexpected structure
    if (
      !emailReadResult ||
      emailReadResult.error ||
      !emailReadResult.success ||
      !emailReadResult.email
    ) {
      console.error(
        "Error reading email:",
        emailReadResult ? emailReadResult.message : "Unknown error"
      )
      // If readEmail returns a message, use it, otherwise default to a generic message
      const message =
        emailReadResult && emailReadResult.message
          ? emailReadResult.message
          : "Invalid email or password."
      // If readEmail returns a status for its error, use it, otherwise default to 401
      const status =
        emailReadResult && emailReadResult.status ? emailReadResult.status : 401
      return { error: true, message: message, status: status }
    }

    const user = emailReadResult.email
    const user_uuid = user.user_uuid

    const passwordVerified = await password_verify(
      dbClient,
      user_uuid,
      password
    )
    if (!passwordVerified || passwordVerified.error) {
      const message =
        passwordVerified && passwordVerified.message
          ? passwordVerified.message
          : "Invalid email or password."
      const status =
        passwordVerified && passwordVerified.status
          ? passwordVerified.status
          : 401
      return { error: true, message: message, status: status }
    }

    // Check for 2FA — has2fa returns boolean on success or { error, status } on failure
    const twoFactorEnabled = await has2fa(dbClient, user_uuid)
    if (typeof twoFactorEnabled === "object" && twoFactorEnabled.error) {
      return {
        error: true,
        message: twoFactorEnabled.error || "Error checking 2FA status.",
        status: twoFactorEnabled.status || 500,
      }
    }

    if (twoFactorEnabled === true) {
      // If 2FA is enabled, return a response indicating that 2FA is required
      // The application should then prompt the user for their TOTP code
      return {
        success: true,
        totp_required: true,
        user_uuid: user_uuid, // Include user_uuid for the next step (verifying TOTP)
        message: "2FA required.",
        status: 202, // Accepted, but further action needed
      }
    }

    // If 2FA is not enabled, proceed to create a session
    const session = await createSession(
      dbClient,
      user_uuid,
      user_agent,
      ip_address,
      ip_country
    )
    if (!session || session.error) {
      return {
        error: true,
        message: session ? session.message : "Session creation failed.",
        status: session ? session.status : 500,
      }
    }

    return {
      success: true,
      session_id: session.session_id,
      user_uuid: user_uuid,
      message: "Login successful.",
      status: 200,
    }
  } catch (error) {
    console.error("Error during user login:", error)
    return {
      error: true,
      message: "An unexpected error occurred during login.",
      status: 500,
    }
  }
}

/**
 * Deletes a user by their UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to delete.
 * @returns {Promise<boolean>} True if the user was deleted, false otherwise.
 */
export async function deleteUser(dbClient, user_uuid) {
  try {
    const result = await dbClient.query(
      "UPDATE users SET user_active = FALSE WHERE user_uuid = $1",
      [user_uuid]
    )
    return result.rowCount > 0
  } catch (error) {
    console.error("Error in deleteUser:", error)
    throw error
  }
}

/**
 * Updates the last login time for a user by their UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to update.
 * @returns {Promise<boolean>} True if the user was updated, false otherwise.
 */
export async function loginUser(dbClient, user_uuid) {
  try {
    const result = await dbClient.query(
      "UPDATE users SET user_last_login = NOW() WHERE user_uuid = $1",
      [user_uuid]
    )
    return result.rowCount > 0
  } catch (error) {
    console.error("Error in loginUser:", error)
    throw error
  }
}
