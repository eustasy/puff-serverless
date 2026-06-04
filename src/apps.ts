// Domain module for the `apps` table — registered OAuth clients. Apps are
// globally registered by the operator (no org FK); the management UI is
// out-of-scope for the current phase, so this module only exposes the read
// side needed by the OAuth endpoints. CRUD for the operator UI can be added
// later without disturbing these functions.
//
// Client secrets are stored hashed in the same `hash:salt` format as user
// passwords (see src/passwords.ts) using the project-wide preferred algorithm,
// so the hashing utilities transfer over directly.

import { PREFERRED_PASSWORD_ALGO, puff_hashing_password } from "./utilities/hashing.js"

/**
 * The four licensing modes an app can declare. `none` skips all license
 * checks; `seat` requires each user/team/org to hold a `license:tier` KV
 * entitlement; `usage` lets any org member through (the app meters usage out
 * of band, the count of users with at least one entitlement row drives the
 * bill); `floating` allocates from a per-org pool of concurrent seats tracked
 * in `app_floating_sessions`.
 */
export const LICENSING_MODES = ["none", "seat", "usage", "floating"] as const
export type AppLicensingMode = (typeof LICENSING_MODES)[number]

/** Type guard for user-supplied licensing mode strings. */
export function isAppLicensingMode(value: unknown): value is AppLicensingMode {
  return typeof value === "string" && (LICENSING_MODES as readonly string[]).includes(value)
}

/**
 * Reserved KV keys the licensing layer reads. Apps may use any other key
 * freely; the namespace `license:*` and `perm:*` are conventions enforced by
 * the entitlement layer, not the database.
 */
export const LICENSE_TIER_KEY = "license:tier"
export const LICENSE_FLOATING_MAX_KEY = "license:floating:max"
export const LICENSE_TIERS_PREFIX = "license:tiers:"
export const LICENSE_PERMS_PREFIX = "license:perms:"
export const PERM_PREFIX = "perm:"

const APP_COLUMNS =
  "app_uuid, app_name, client_id, client_secret, redirect_uris, app_active, app_licensing_mode, app_default_trial_days, app_created_at"

/**
 * Read a single app by its app_uuid. The app must be active (`app_active` is
 * TRUE); a disabled app is treated as not found from the OAuth layer's point
 * of view — its tokens are rejected without leaking that the registration
 * still exists.
 */
export async function readApp(dbClient: DbClient, app_uuid: string): Promise<Envelope<{ app: AppRow }>> {
  try {
    const query = `
      SELECT ${APP_COLUMNS}
      FROM apps
      WHERE app_uuid = $1 AND app_active = TRUE
      LIMIT 1
    `
    const { rows } = await dbClient.query(query, [app_uuid])
    if (rows.length > 0) {
      return { success: true, app: rows[0], status: 200 }
    }
    return { success: false, message: "App not found.", status: 404 }
  } catch (error) {
    console.error("Error in readApp:", error)
    return {
      error: true,
      message: "Could not read app.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Read a single app by its public `client_id`. Used as the very first step of
 * /oauth/authorize and /oauth/token to resolve the request to a registered
 * app. Same active-only filter as readApp.
 */
export async function readAppByClientId(dbClient: DbClient, client_id: string): Promise<Envelope<{ app: AppRow }>> {
  try {
    const query = `
      SELECT ${APP_COLUMNS}
      FROM apps
      WHERE client_id = $1 AND app_active = TRUE
      LIMIT 1
    `
    const { rows } = await dbClient.query(query, [client_id])
    if (rows.length > 0) {
      return { success: true, app: rows[0], status: 200 }
    }
    return { success: false, message: "App not found.", status: 404 }
  } catch (error) {
    console.error("Error in readAppByClientId:", error)
    return {
      error: true,
      message: "Could not read app.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Verify a candidate client_secret against the stored hash for an app. Mirrors
 * verifyPassword: the stored value is `hash:salt`, the candidate is re-hashed
 * with the same salt and the project's preferred algorithm, then compared.
 *
 * Returns `verified: false` (not an error) for a wrong secret or an
 * unrecognised stored format, so the caller decides whether to surface a 401
 * or a generic invalid-client OAuth error.
 */
export async function verifyAppCredentials(
  dbClient: DbClient,
  client_id: string,
  client_secret: string
): Promise<Envelope<{ verified: boolean; app: AppRow | null }>> {
  try {
    const lookup = await readAppByClientId(dbClient, client_id)
    if (lookup.error) {
      return { error: true, message: lookup.message, status: 500 }
    }
    if (!lookup.success) {
      return { success: true, verified: false, app: null, status: 200 }
    }
    const stored = lookup.app.client_secret
    const sep = stored.indexOf(":")
    if (sep < 0) {
      return { success: true, verified: false, app: null, status: 200 }
    }
    const stored_hash = stored.slice(0, sep)
    const salt = stored.slice(sep + 1)
    const { hash: candidate_hash } = await puff_hashing_password(client_secret, salt, PREFERRED_PASSWORD_ALGO)
    return {
      success: true,
      verified: candidate_hash === stored_hash,
      app: candidate_hash === stored_hash ? lookup.app : null,
      status: 200,
    }
  } catch (error) {
    console.error("Error in verifyAppCredentials:", error)
    return {
      error: true,
      message: "Could not verify app credentials.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * List all apps (active and disabled). Intended for the future operator
 * management UI, not the OAuth endpoints.
 */
export async function listApps(dbClient: DbClient): Promise<Envelope<{ apps: AppRow[] }>> {
  try {
    const query = `
      SELECT ${APP_COLUMNS}
      FROM apps
      ORDER BY app_created_at DESC
    `
    const { rows } = await dbClient.query(query)
    return { success: true, apps: rows, status: 200 }
  } catch (error) {
    console.error("Error in listApps:", error)
    return {
      error: true,
      message: "Could not list apps.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Hash a plain-text client_secret using the project's preferred password
 * algorithm and storage format (`hash:salt`). Exposed so the operator
 * registration flow (direct DB or future UI) can produce a valid secret row.
 */
export async function hashClientSecret(client_secret: string): Promise<{ stored: string; algo: string }> {
  const { hash, salt, algo } = await puff_hashing_password(client_secret)
  return { stored: `${hash}:${salt}`, algo }
}

/**
 * Reads the tiers an app declares for itself. Tiers live in `app_key_values`
 * with the app as both subject and owner, under the `license:tiers:<name>` key
 * convention — the key suffix is the tier identifier (the value users get
 * granted in `license:tier`), the value is the human-readable label or
 * description. Returns an empty list when the app has not declared any.
 */
export async function listAppTiers(dbClient: DbClient, app_uuid: string): Promise<Envelope<{ tiers: { name: string; label: string }[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT kv_key, kv_value FROM app_key_values WHERE app_uuid = $1 AND owner_app_uuid = $1 AND kv_key LIKE $2 ESCAPE '\\' ORDER BY kv_key ASC`,
      [app_uuid, `${LICENSE_TIERS_PREFIX}%`]
    )
    const tiers = rows.map((row) => ({
      name: row.kv_key.slice(LICENSE_TIERS_PREFIX.length),
      label: row.kv_value,
    }))
    return { success: true, tiers, status: 200 }
  } catch (error) {
    console.error("Error in listAppTiers:", error)
    return {
      error: true,
      message: "Could not list app tiers.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reads the permission keys an app declares for itself. Apps may publish the
 * full set of `perm:*` keys they recognise so an operator UI can offer them as
 * a checklist when an org grants entitlements. Stored in `app_key_values`
 * (subject = owner = app) under `license:perms:<name>` keys; the key suffix
 * is the permission identifier and the value is the display label.
 */
export async function listAppPermissions(
  dbClient: DbClient,
  app_uuid: string
): Promise<Envelope<{ perms: { name: string; label: string }[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT kv_key, kv_value FROM app_key_values WHERE app_uuid = $1 AND owner_app_uuid = $1 AND kv_key LIKE $2 ESCAPE '\\' ORDER BY kv_key ASC`,
      [app_uuid, `${LICENSE_PERMS_PREFIX}%`]
    )
    const perms = rows.map((row) => ({
      name: row.kv_key.slice(LICENSE_PERMS_PREFIX.length),
      label: row.kv_value,
    }))
    return { success: true, perms, status: 200 }
  } catch (error) {
    console.error("Error in listAppPermissions:", error)
    return {
      error: true,
      message: "Could not list app permissions.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
