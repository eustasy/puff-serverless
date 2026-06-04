// Domain module for the `oauth_consents` table — remembered per-(user, app)
// scope grants so the consent screen is skipped on the next round-trip.
//
// Re-consenting replaces the stored scope set; revocation is a DELETE. There
// is no `is_used` here — the consent row IS the consent, and removing it
// withdraws permission immediately.

/**
 * Read the existing consent for (user, app). Returns `{ exists: false }` when
 * the user has never consented to this app, or `{ exists: true, consent }`
 * with the stored scope set.
 */
export async function readConsent(
  dbClient: DbClient,
  user_uuid: string,
  app_uuid: string
): Promise<Envelope<{ exists: true; consent: OAuthConsentRow } | { exists: false }>> {
  try {
    const query = `
      SELECT user_uuid, app_uuid, scopes, granted_at
      FROM oauth_consents
      WHERE user_uuid = $1 AND app_uuid = $2
      LIMIT 1
    `
    const { rows } = await dbClient.query(query, [user_uuid, app_uuid])
    if (rows.length > 0) {
      return { success: true, exists: true, consent: rows[0], status: 200 }
    }
    return { success: true, exists: false, status: 200 }
  } catch (error) {
    console.error("Error in readConsent:", error)
    return {
      error: true,
      message: "Could not read consent.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Store (or replace) the user's consent for `app_uuid` to cover `scopes`.
 * UPSERT semantics: re-consenting with a different scope set replaces the
 * stored array and refreshes `granted_at`.
 */
export async function upsertConsent(
  dbClient: DbClient,
  user_uuid: string,
  app_uuid: string,
  scopes: string[]
): Promise<Envelope<{ consent: OAuthConsentRow }>> {
  try {
    const query = `
      INSERT INTO oauth_consents (user_uuid, app_uuid, scopes, granted_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (user_uuid, app_uuid)
      DO UPDATE SET scopes = EXCLUDED.scopes, granted_at = EXCLUDED.granted_at
      RETURNING user_uuid, app_uuid, scopes, granted_at
    `
    const { rows } = await dbClient.query(query, [user_uuid, app_uuid, scopes])
    if (rows.length === 0) {
      return {
        error: true,
        message: "Consent upsert returned no row.",
        status: 500,
      }
    }
    return { success: true, consent: rows[0], status: 200 }
  } catch (error) {
    console.error("Error in upsertConsent:", error)
    return {
      error: true,
      message: "Could not store consent.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Withdraw the user's consent for this app. Safe to call when no consent
 * exists — returns `revoked: false` in that case rather than erroring.
 */
export async function revokeConsent(dbClient: DbClient, user_uuid: string, app_uuid: string): Promise<Envelope<{ revoked: boolean }>> {
  try {
    const query = `
      DELETE FROM oauth_consents
      WHERE user_uuid = $1 AND app_uuid = $2
      RETURNING user_uuid
    `
    const { rows } = await dbClient.query(query, [user_uuid, app_uuid])
    return { success: true, revoked: rows.length > 0, status: 200 }
  } catch (error) {
    console.error("Error in revokeConsent:", error)
    return {
      error: true,
      message: "Could not revoke consent.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * True when the stored consent already covers every scope in `requested`. A
 * missing consent row returns false. Used by /oauth/authorize to decide
 * whether to skip the consent screen.
 */
export async function hasConsentFor(
  dbClient: DbClient,
  user_uuid: string,
  app_uuid: string,
  requested: string[]
): Promise<Envelope<{ covered: boolean }>> {
  const read = await readConsent(dbClient, user_uuid, app_uuid)
  if (read.error) {
    return { error: true, message: read.message, status: read.status }
  }
  if (!read.success || !read.exists) {
    return { success: true, covered: false, status: 200 }
  }
  const stored = new Set(read.consent.scopes)
  for (const s of requested) {
    if (!stored.has(s)) {
      return { success: true, covered: false, status: 200 }
    }
  }
  return { success: true, covered: true, status: 200 }
}
