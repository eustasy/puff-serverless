import {
  puff_hashing_sha1_hibp,
  puff_hashing_password,
  passwordNeedsUpgrade,
} from "./utilities/hashing.js"
import zxcvbn from "zxcvbn"
import { escapeHtml } from "./utilities/escape.js"
import { runInTransaction, Rollback } from "./utilities/transaction.js"

/**
 * Creates a new password hash for a user and stores it in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} password - The plain text password.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, message, status: 400 }` on validation failure, or an error envelope.
 */
export async function createPassword(
  dbClient: DbClient,
  user_uuid: string,
  password: string
): Promise<Envelope> {
  try {
    // Validate password requirements
    const isValid = await passwordRequirements(password)
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
      details: error instanceof Error ? error.message : String(error),
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
export async function readPassword(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ secret_value: string; algo: string }>> {
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
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Disables all active 'puff_password_%' type secrets for a user.
 * Sets is_enabled to FALSE and updates secret_last_used.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @returns {Promise<Envelope<{ disabled: boolean }>>} `{ success: true, disabled }` where `disabled` is false when no active password was found, or an error envelope.
 */
export async function disablePassword(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ disabled: boolean }>> {
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
      details: error instanceof Error ? error.message : String(error),
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
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }` or an error envelope.
 */
export async function updatePassword(
  dbClient: DbClient,
  user_uuid: string,
  newPassword: string
): Promise<Envelope> {
  try {
    // Atomic disable-then-create so a failure between the two doesn't leave
    // the user with no enabled password. runInTransaction retries the whole
    // pair on a SERIALIZABLE serialization failure.
    return await runInTransaction(dbClient, async (): Promise<Envelope> => {
      const disableResult = await disablePassword(dbClient, user_uuid)
      if (disableResult.error) {
        throw new Rollback<Envelope>(disableResult)
      }
      const createResult = await createPassword(
        dbClient,
        user_uuid,
        newPassword
      )
      if (createResult.error || !createResult.success) {
        // Propagate the inner envelope: validation failures keep their 400,
        // DB errors keep their 500. Either way roll back the disable.
        throw new Rollback<Envelope>(createResult)
      }
      return { success: true, status: 200 }
    })
  } catch (error) {
    console.error("Error in updatePassword:", error)
    return {
      error: true,
      message: "Could not update password.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Verifies a user's password against the stored hash in the database.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user to verify the password for.
 * @param {string} pw - The plain text password to verify.
 * @returns {Promise<object>} `{ success: true, verified: boolean, needs_upgrade: boolean, status: 200 }` or `{ error: true, message, status }` on DB error.
 */
export async function verifyPassword(
  dbClient: DbClient,
  user_uuid: string,
  pw: string
): Promise<
  | {
      success: true
      error?: never
      verified: boolean
      needs_upgrade: boolean
      status: 200
    }
  | {
      success?: never
      error: true
      message: string
      details?: unknown
      status: number
    }
> {
  try {
    const passwordResult = await readPassword(dbClient, user_uuid)

    if (passwordResult.error) {
      return {
        error: true,
        message:
          passwordResult.message || "Error during password verification.",
        details: passwordResult.details,
        status: 500,
      }
    }

    if (!passwordResult.success) {
      // No active password found for the user — treat as a "verification ran,
      // answer is no" rather than an error, so the caller can decide whether
      // to expose this or fold it into a generic 401.
      console.warn(
        `Password verification failed: No active password found for user_uuid ${user_uuid}`
      )
      return {
        success: true,
        verified: false,
        needs_upgrade: false,
        status: 200,
      }
    }

    const { secret_value, algo } = passwordResult
    const [actual_hash, salt] = secret_value.split(":")

    const { hash: attempted_hash } = await puff_hashing_password(pw, salt, algo)

    return {
      success: true,
      verified: attempted_hash === actual_hash,
      // Only meaningful when verified — a wrong password never triggers a
      // re-hash. The caller gates the upgrade on a successful login.
      needs_upgrade: passwordNeedsUpgrade(algo),
      status: 200,
    }
  } catch (error) {
    console.error("Error during password verification:", error)
    return {
      error: true,
      message: "Error during password verification.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Checks whether a candidate password matches any password the user has used
 * before — their current one or any historical one. Every password change
 * retains the old 'puff_password_%' secret row (is_enabled = FALSE), each with
 * its own salt and algorithm, so reuse is detected by re-hashing the candidate
 * with each stored row's salt+algo and comparing.
 *
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The UUID of the user.
 * @param {string} candidate - The plain text password being proposed.
 * @returns Envelope: `{ success: true, reused: boolean, status: 200 }`, or
 *          `{ error: true, message, details, status: 500 }` on DB error.
 */
export async function isPasswordReused(
  dbClient: DbClient,
  user_uuid: string,
  candidate: string
): Promise<
  | { success: true; error?: never; reused: boolean; status: 200 }
  | {
      success?: never
      error: true
      message: string
      details?: unknown
      status: number
    }
> {
  try {
    // Every password row, enabled or not — the current password counts as
    // reuse too, so there is no is_enabled filter.
    const query = `
      SELECT secret_type, secret_value
      FROM secrets
      WHERE user_uuid = $1 AND secret_type LIKE 'puff_password_%';
    `
    const result = await dbClient.query(query, [user_uuid])

    for (const row of result.rows) {
      const [stored_hash, salt] = row.secret_value.split(":")
      // Skip any malformed row rather than letting it abort the whole check.
      if (!stored_hash || !salt) continue
      const algo = row.secret_type.replace("puff_password_", "")
      const { hash } = await puff_hashing_password(candidate, salt, algo)
      if (hash === stored_hash) {
        return { success: true, reused: true, status: 200 }
      }
    }

    return { success: true, reused: false, status: 200 }
  } catch (error) {
    console.error("Error in isPasswordReused:", error)
    return {
      error: true,
      message: "Could not check password history.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// The built-in minimum password length. MIN_PASSWORD_LENGTH (an operator-set
// runtime var) can only raise the minimum above this floor — see
// minPasswordLength — so endpoint checks are always >= this value and the
// env-free createPassword check below can never be stricter than the caller.
export const DEFAULT_MIN_PASSWORD_LENGTH = 12

/**
 * Resolves the configured minimum password length. MIN_PASSWORD_LENGTH is
 * optional and operator-set; a missing, non-numeric, or below-floor value
 * falls back to DEFAULT_MIN_PASSWORD_LENGTH. The minimum can only be raised,
 * never lowered below the built-in floor.
 * @param {Env} env - The Worker environment bindings.
 * @returns {number} The effective minimum password length.
 */
export function minPasswordLength(env: Env): number {
  const parsed = parseInt(env.MIN_PASSWORD_LENGTH ?? "", 10)
  return Number.isInteger(parsed) && parsed > DEFAULT_MIN_PASSWORD_LENGTH
    ? parsed
    : DEFAULT_MIN_PASSWORD_LENGTH
}

/**
 * All operator-configurable password-policy settings resolved from env vars.
 * Pass this to `passwordRequirements` and `passwordRequirementsHtml` so they
 * apply the same policy. See docs/Architecture.md "Environment variables".
 */
export interface PasswordConfig {
  minLength: number
  requireNumber: boolean
  requireCapital: boolean
  requireSpecial: boolean
  /** Fail if the password appears in HaveIBeenPwned breach data. */
  requireNotCompromised: boolean
  showZxcvbn: boolean
  /** When true, zxcvbn score ≥ 3 is the hard gate; individual require* rules
   *  are shown as suggestions rather than enforced. minLength still applies. */
  requireZxcvbn: boolean
}

// Canonical all-off config used when a plain minLength number is passed.
function minLengthOnlyConfig(minLength: number): PasswordConfig {
  return {
    minLength,
    requireNumber: false,
    requireCapital: false,
    requireSpecial: false,
    requireNotCompromised: false,
    showZxcvbn: false,
    requireZxcvbn: false,
  }
}

/**
 * Builds a PasswordConfig from the Worker environment bindings.
 * @param {Env} env - The Worker environment bindings.
 * @returns {PasswordConfig} Resolved policy ready for the requirement functions.
 */
export function passwordConfig(env: Env): PasswordConfig {
  const requireZxcvbn = env.REQUIRE_ZXCVBN === "true"
  return {
    minLength: minPasswordLength(env),
    requireNumber: env.REQUIRE_NUMBER === "true",
    requireCapital: env.REQUIRE_CAPITAL === "true",
    requireSpecial: env.REQUIRE_SPECIAL_CHAR === "true",
    requireNotCompromised: env.REQUIRE_NOT_COMPROMISED === "true",
    showZxcvbn: requireZxcvbn || env.SHOW_ZXCVBN === "true",
    requireZxcvbn,
  }
}

// Shared HIBP k-anonymity lookup. Returns the breach count (0 = clean).
// Throws on network error so callers can decide how to handle unavailability.
async function hibpBreachCount(pw: string): Promise<number> {
  const pwSha1 = await puff_hashing_sha1_hibp(pw)
  const response = await fetch(
    "https://api.pwnedpasswords.com/range/" + pwSha1.f5
  )
  const text = await response.text()
  for (const line of text.split("\n")) {
    if (line.slice(0, 35) === pwSha1.l35.toUpperCase()) {
      return parseInt(line.substring(36))
    }
  }
  return 0
}

/**
 * Returns true if the password meets all configured requirements; false if it
 * falls short. Pass a `PasswordConfig` (from `passwordConfig(env)`) for the
 * full policy, or a plain number for a length-only check (used internally by
 * `createPassword`, which has no env access).
 * Use `passwordRequirementsHtml` for a user-facing breakdown of each criterion.
 * When `requireNotCompromised` is set this makes a network call to HIBP; a
 * fetch error is treated as passing (fail-open) so a HIBP outage never blocks
 * legitimate users.
 * @param {string} pw - The password to check.
 * @param {PasswordConfig | number} config - Policy config or minimum length.
 * @returns {Promise<boolean>} True if all requirements are met, false otherwise.
 */
export async function passwordRequirements(
  pw: string,
  config: PasswordConfig | number = DEFAULT_MIN_PASSWORD_LENGTH
): Promise<boolean> {
  const cfg = typeof config === "number" ? minLengthOnlyConfig(config) : config

  if (pw.length < cfg.minLength) return false

  if (cfg.requireZxcvbn) {
    if (zxcvbn(pw).score < 3) return false
  } else {
    if (cfg.requireNumber && !/\d/.test(pw)) return false
    if (cfg.requireCapital && !/[A-Z]/.test(pw)) return false
    if (cfg.requireSpecial && !/[^a-zA-Z\d]/.test(pw)) return false
  }

  if (cfg.requireNotCompromised) {
    try {
      if ((await hibpBreachCount(pw)) > 0) return false
    } catch {
      // Fail-open: HIBP unavailability must not block legitimate users.
    }
  }

  return true
}

const ZXCVBN_LABELS = ["Too weak", "Weak", "Fair", "Strong", "Very strong"]

/**
 * Returns an HTML fragment listing each password requirement with pass/fail
 * styling. Includes a zxcvbn strength estimate (when configured) and a
 * HaveIBeenPwned k-anonymity lookup. Use `passwordRequirements` for a boolean
 * check without the HTML or network call.
 * @param {string} pw - The password to check.
 * @param {PasswordConfig | number} config - Policy config or minimum length.
 * @returns {Promise<string>} HTML fragment with per-criterion pass/fail indicators.
 */
export async function passwordRequirementsHtml(
  pw: string,
  config: PasswordConfig | number = DEFAULT_MIN_PASSWORD_LENGTH
): Promise<string> {
  const cfg = typeof config === "number" ? minLengthOnlyConfig(config) : config

  let html = "<h3>Password Requirements</h3><ul>"

  // Min length — always enforced regardless of other settings.
  const lengthOk = pw.length >= cfg.minLength
  html += `<li class="${lengthOk ? "result-positive" : "result-negative"}"><strong>Must</strong> be at least ${cfg.minLength} characters long</li>`

  // Individual character-class rules. When zxcvbn is the hard gate these are
  // shown as suggestions ("Should") rather than hard requirements ("Must").
  const ruleStrength = cfg.requireZxcvbn ? "Should" : "<strong>Must</strong>"
  if (cfg.requireNumber) {
    const ok = /\d/.test(pw)
    html += `<li class="${ok ? "result-positive" : "result-negative"}">${ruleStrength} contain a number</li>`
  }
  if (cfg.requireCapital) {
    const ok = /[A-Z]/.test(pw)
    html += `<li class="${ok ? "result-positive" : "result-negative"}">${ruleStrength} contain an uppercase letter</li>`
  }
  if (cfg.requireSpecial) {
    const ok = /[^a-zA-Z\d]/.test(pw)
    html += `<li class="${ok ? "result-positive" : "result-negative"}">${ruleStrength} contain a special character</li>`
  }

  // zxcvbn strength estimate — shown when SHOW_ZXCVBN or REQUIRE_ZXCVBN is set.
  if (cfg.showZxcvbn) {
    const est = zxcvbn(pw)
    const passing = est.score >= 3
    const label = ZXCVBN_LABELS[est.score]
    const prefix = cfg.requireZxcvbn
      ? "<strong>Must</strong> be strong enough — "
      : "Password strength: "
    html += `<li class="${passing ? "result-positive" : "result-negative"}">${prefix}${escapeHtml(label)}`
    if (est.feedback.warning) {
      html += ` — ${escapeHtml(est.feedback.warning)}`
    }
    html += "</li>"
    for (const suggestion of est.feedback.suggestions) {
      html += `<li class="result-info">${escapeHtml(suggestion)}</li>`
    }
  }

  // HaveIBeenPwned k-anonymity check — shown only when enforced, so the UI
  // mirrors the policy. Same gate as in `passwordRequirements`, which also
  // means a single submission round-trip makes at most two HIBP calls
  // (one from each function on the failure path) instead of three.
  if (cfg.requireNotCompromised) {
    try {
      const count = await hibpBreachCount(pw)
      if (count > 0) {
        html += `<li class="result-negative">Found in ${Intl.NumberFormat().format(count)} known data breach${count === 1 ? "" : "es"}</li>`
      } else {
        html += `<li class="result-positive"><strong>Must</strong> not be in known data breaches</li>`
      }
    } catch (err) {
      // Fail-open at the boolean gate too — log the real cause, show a
      // user-friendly placeholder. `escapeHtml` is defence-in-depth; the
      // throw site is in-house so the message is currently safe, but a
      // future refactor must not be able to inject HTML.
      console.error("HIBP breach lookup failed:", err)
      html += `<li class="result-info">${escapeHtml("Unable to check breach status right now — your password will be accepted if it meets the other requirements.")}</li>`
    }
  }

  html += "</ul>"
  return html
}
