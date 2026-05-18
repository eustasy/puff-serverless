import { createSession, terminateAllSessions } from "./sessions.js"
import { createEmail, existsEmail, readEmail } from "./emails.js"
import {
  createPassword,
  verifyPassword,
  isPasswordReused,
  updatePassword,
} from "./passwords.js"
import { has2fa } from "./2fa.js"
import { sendVerificationEmail } from "./mailer.js"
import { runInTransaction, Rollback } from "./utilities/transaction.js"

/**
 * Retrieves a user's details by their UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<object>} - Envelope: `{ success: true, user, status: 200 }` on hit, `{ success: false, message, status: 404 }` on miss, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function readUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ user: UserRow }>> {
  try {
    const query =
      "SELECT user_uuid, user_name, user_created_at, user_last_login FROM users WHERE user_uuid = $1 AND user_active = TRUE LIMIT 1"
    const result = await dbClient.query(query, [user_uuid])
    if (result.rows.length > 0) {
      return { success: true, user: result.rows[0], status: 200 }
    }
    return { success: false, message: "User not found.", status: 404 }
  } catch (error) {
    console.error("Error in readUser:", error)
    return {
      error: true,
      message: "Could not read user.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

export async function registerUser(
  dbClient: DbClient,
  env: Env,
  name: string,
  email: string,
  password: string
): Promise<{ success: true; user_uuid: string; email: string }> {
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
    // Send the verification email. A delivery failure is non-fatal: the account
    // is already created, and the user can request a fresh link from the resend
    // flow — so we log and continue rather than aborting registration.
    if (createEmailResult.token_value) {
      const mailResult = await sendVerificationEmail(
        env,
        email,
        createEmailResult.token_value
      )
      if (mailResult.error) {
        console.error(
          "Failed to send verification email during registration:",
          mailResult.message
        )
      }
    }

    // Step 3. Register the password using createPassword
    const createResult = await createPassword(dbClient, uuid, password)
    if (createResult.error || !createResult.success) {
      throw new Error(
        createResult.message || "Failed to create password during registration."
      )
    }

    return { success: true, user_uuid: uuid, email: email }
  } catch (error) {
    console.error("Error during user registration:", error)
    // Propagate the error or return a structured error response
    throw error // Or return { error: true, message: error.message }
  }
}

// Outcome of a password-login attempt. One error variant and three success
// variants: 2FA required, password upgrade required, or a session granted.
// loginOutcomeResponse (src/utilities/login-response.ts) turns the success
// variants into the corresponding HTTP response.
export type UserLoginResult =
  | {
      success?: never
      error: true
      message: string
      status: number
      totp_required?: never
      password_upgrade_required?: never
      session_id?: never
      user_uuid?: never
    }
  | {
      success: true
      error?: never
      totp_required: true
      password_upgrade_required?: never
      session_id?: never
      user_uuid: string
      message: string
      status: number
    }
  | {
      success: true
      error?: never
      password_upgrade_required: true
      totp_required?: never
      session_id?: never
      user_uuid: string
      message: string
      status: number
    }
  | {
      success: true
      error?: never
      session_id: string
      totp_required?: never
      password_upgrade_required?: never
      user_uuid: string
      message: string
      status: number
    }

export type UserLoginSuccess = Extract<UserLoginResult, { success: true }>

export async function loginUser(
  dbClient: DbClient,
  email: string,
  password: string,
  user_agent: string,
  ip_address: string,
  ip_country: string,
  min_password_length: number
): Promise<UserLoginResult> {
  try {
    const emailReadResult = await readEmail(dbClient, email)

    if (emailReadResult.error) {
      console.error("Error reading email:", emailReadResult.message)
      return {
        error: true,
        message: "Invalid email or password.",
        status: 401,
      }
    }
    if (!emailReadResult.success) {
      // Email not found — log internally, return generic message to avoid enumeration.
      console.error("Error reading email:", emailReadResult.message)
      return {
        error: true,
        message: "Invalid email or password.",
        status: 401,
      }
    }

    const user = emailReadResult.email
    const user_uuid = user.user_uuid

    const verifyResult = await verifyPassword(dbClient, user_uuid, password)
    if (verifyResult.error) {
      return {
        error: true,
        message: verifyResult.message || "Error during password verification.",
        status: verifyResult.status || 500,
      }
    }
    if (!verifyResult.verified) {
      // The current password didn't match. Check whether the supplied value is
      // one the user previously used on this account (a now-disabled secret
      // row) and, if so, give a more helpful prompt than the generic failure.
      // We only reach here once the active password has already failed above,
      // so any isPasswordReused hit is necessarily a *previous* password.
      // A DB error here is non-fatal — fall through to the generic message.
      const previous = await isPasswordReused(dbClient, user_uuid, password)
      if (previous.success && previous.reused) {
        return {
          error: true,
          message:
            "That is a password you previously used on this account. Please enter your current password, or reset it if you have forgotten it.",
          status: 401,
        }
      }
      return {
        error: true,
        message: "Invalid email or password.",
        status: 401,
      }
    }

    // Reject logins for disabled accounts (see disableUser). Checked only
    // after the password is proven, so a wrong password still gets the
    // generic failure and the disabled state is never revealed to anyone who
    // cannot already authenticate. A missing users row (should not happen —
    // emails has a foreign key) is treated as disabled, failing closed.
    const activeResult = await dbClient.query(
      "SELECT user_active FROM users WHERE user_uuid = $1 LIMIT 1",
      [user_uuid]
    )
    if (activeResult.rows[0]?.user_active !== true) {
      return {
        error: true,
        message:
          "This account has been disabled. Please contact support if you believe this is an error.",
        status: 403,
      }
    }

    // Force-upgrade a password that is now shorter than the configured
    // minimum (MIN_PASSWORD_LENGTH may have been raised since it was set).
    // The plaintext is only available here, at login, so the length re-check
    // has to happen now. The caller routes the user to a forced
    // password-change step before any session is granted. This is checked
    // ahead of the hash re-hash and the 2FA gate: the upgrade flow writes a
    // fresh hash anyway, and 2FA is resumed once the new password is set.
    if (password.length < min_password_length) {
      return {
        success: true,
        password_upgrade_required: true,
        user_uuid: user_uuid,
        message: "Password upgrade required.",
        status: 202,
      }
    }

    // Transparently re-hash a password stored under an outdated algorithm so it
    // migrates to the current one without the user noticing. Best-effort: this
    // runs once the password is proven, before the 2FA gate, and a failed
    // upgrade (e.g. the old password no longer meets requirements) must never
    // block an otherwise valid login.
    if (verifyResult.needs_upgrade) {
      const upgradeResult = await updatePassword(dbClient, user_uuid, password)
      if (upgradeResult.error || !upgradeResult.success) {
        console.error(
          `Password-hash upgrade-on-login failed for user_uuid ${user_uuid}: ${upgradeResult.message}`
        )
      }
    }

    // Check for 2FA
    const twoFactorResult = await has2fa(dbClient, user_uuid)
    if (twoFactorResult.error) {
      return {
        error: true,
        message: twoFactorResult.message || "Error checking 2FA status.",
        status: twoFactorResult.status || 500,
      }
    }

    if (twoFactorResult.enabled) {
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
    if (!session.success) {
      return {
        error: true,
        message: session.error,
        status: session.status,
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
 * Disables a user account (reversible). Sets `user_active = FALSE` and
 * terminates every active session in one transaction, so the user is logged
 * out everywhere immediately and `loginUser` will reject them. Reverse with
 * `enableUser`; for a permanent removal use `deleteUser`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to disable.
 * @returns {Promise<object>} Envelope: `{ success: true, terminated_sessions, status: 200 }` on hit, `{ success: false, message, status: 404 }` if no such user, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function disableUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ terminated_sessions: number }>> {
  try {
    // Flag flip and session purge are one unit: a user must never be left
    // marked inactive while still holding a live session, or vice versa.
    // runInTransaction retries the pair on a SERIALIZABLE serialization failure.
    type DisableResult = Envelope<{ terminated_sessions: number }>
    return await runInTransaction(
      dbClient,
      async (): Promise<DisableResult> => {
        const result = await dbClient.query(
          "UPDATE users SET user_active = FALSE WHERE user_uuid = $1 RETURNING user_uuid",
          [user_uuid]
        )
        if ((result.rowCount ?? 0) === 0) {
          throw new Rollback<DisableResult>({
            success: false,
            message: "User not found.",
            status: 404,
          })
        }
        const sessions = await terminateAllSessions(dbClient, user_uuid)
        if (!sessions.success) {
          throw new Rollback<DisableResult>({
            error: true,
            message: sessions.error,
            status: sessions.status,
          })
        }
        return {
          success: true,
          terminated_sessions: sessions.deletedCount,
          status: 200,
        }
      }
    )
  } catch (error) {
    console.error("Error in disableUser:", error)
    return {
      error: true,
      message: "Could not disable user.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Re-enables a previously disabled user account (sets `user_active = TRUE`).
 * Sessions terminated by `disableUser` are not restored — the user logs in
 * fresh. Idempotent: enabling an already-active account succeeds.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to enable.
 * @returns {Promise<object>} Envelope: `{ success: true, status: 200 }` on hit, `{ success: false, message, status: 404 }` if no such user, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function enableUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "UPDATE users SET user_active = TRUE WHERE user_uuid = $1",
      [user_uuid]
    )
    if ((result.rowCount ?? 0) > 0) {
      return { success: true, status: 200 }
    }
    return { success: false, message: "User not found.", status: 404 }
  } catch (error) {
    console.error("Error in enableUser:", error)
    return {
      error: true,
      message: "Could not enable user.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Permanently deletes a user and every row that belongs to them — sessions,
 * secrets, emails, tokens, and TOTP replay-guard rows. Irreversible; for a
 * reversible suspension use `disableUser`.
 *
 * Child rows are removed by the `ON DELETE CASCADE` on each child table's
 * `user_uuid` foreign key (see `sql/*.sql`), so a single `DELETE FROM users`
 * is atomic and sufficient — no explicit transaction or per-table delete.
 * Note: a database created before the cascade was added must have the
 * `ALTER TABLE … ADD CONSTRAINT … ON DELETE CASCADE` migration applied, or
 * this fails with a foreign-key violation.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to delete.
 * @returns {Promise<object>} Envelope: `{ success: true, status: 200 }` on hit, `{ success: false, message, status: 404 }` if no such user, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function deleteUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "DELETE FROM users WHERE user_uuid = $1 RETURNING user_uuid",
      [user_uuid]
    )
    if ((result.rowCount ?? 0) > 0) {
      return { success: true, status: 200 }
    }
    return { success: false, message: "User not found.", status: 404 }
  } catch (error) {
    console.error("Error in deleteUser:", error)
    return {
      error: true,
      message: "Could not delete user.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Updates the last login time for a user by their UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to update.
 * @returns {Promise<object>} Envelope: `{ success: true, status: 200 }` if a row was updated, `{ success: false, message, status: 404 }` if not, `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function updateLastLogin(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "UPDATE users SET user_last_login = NOW() WHERE user_uuid = $1",
      [user_uuid]
    )
    if ((result.rowCount ?? 0) > 0) {
      return { success: true, status: 200 }
    }
    return { success: false, message: "User not found.", status: 404 }
  } catch (error) {
    console.error("Error in updateLastLogin:", error)
    return {
      error: true,
      message: "Could not update last login timestamp.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
