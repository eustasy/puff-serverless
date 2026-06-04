// Domain module for `external_identities` — the link table between a Puff
// user and a third-party identity (GitHub / Google / Microsoft).
//
// Linking is a state change separate from issuing a session: a user may
// have several providers linked. Unlinking is gated on retaining at least
// one other usable credential (password / passkey / another provider) so a
// user can never lock themselves out of their account.

import { runInTransaction, Rollback } from "./utilities/transaction.js"

// SQLSTATE for a unique-constraint violation — the (provider, provider_user_id)
// pair is already linked to a different user.
const UNIQUE_VIOLATION = "23505"

/** Reads every identity linked to a user, oldest first. */
export async function listExternalIdentities(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ identities: ExternalIdentityRow[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT user_uuid, provider, provider_user_id, email, display_name, linked_at, last_used_at
         FROM external_identities
        WHERE user_uuid = $1
        ORDER BY linked_at ASC`,
      [user_uuid]
    )
    return { success: true, identities: rows, status: 200 }
  } catch (error) {
    console.error("Error in listExternalIdentities:", error)
    return {
      error: true,
      message: "Could not list linked identities.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Look up an identity by `(provider, provider_user_id)`. Used at OAuth
 * callback time to decide whether the federated user already has a linked
 * Puff account.
 */
export async function findByProvider(
  dbClient: DbClient,
  provider: string,
  provider_user_id: string
): Promise<Envelope<{ identity: ExternalIdentityRow | null }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT user_uuid, provider, provider_user_id, email, display_name, linked_at, last_used_at
         FROM external_identities
        WHERE provider = $1 AND provider_user_id = $2
        LIMIT 1`,
      [provider, provider_user_id]
    )
    return {
      success: true,
      identity: (rows[0] as ExternalIdentityRow | undefined) ?? null,
      status: 200,
    }
  } catch (error) {
    console.error("Error in findByProvider:", error)
    return {
      error: true,
      message: "Could not look up linked identity.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

interface LinkInput {
  user_uuid: string
  provider: string
  provider_user_id: string
  email: string | null
  display_name: string | null
}

/**
 * Links an external identity to a Puff user. Idempotent against the same
 * user — re-linking refreshes the email/display_name; trying to link a
 * (provider, provider_user_id) that already belongs to a different user
 * returns 409.
 */
export async function linkExternalIdentity(dbClient: DbClient, input: LinkInput): Promise<Envelope<{ linked: "created" | "updated" }>> {
  try {
    const { rows } = await dbClient.query(
      `INSERT INTO external_identities
          (user_uuid, provider, provider_user_id, email, display_name)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (provider, provider_user_id) DO UPDATE
          SET email = EXCLUDED.email,
              display_name = EXCLUDED.display_name
          WHERE external_identities.user_uuid = EXCLUDED.user_uuid
        RETURNING (xmax = 0) AS inserted`,
      [input.user_uuid, input.provider, input.provider_user_id, input.email, input.display_name]
    )
    if (rows.length === 0) {
      // The ON CONFLICT WHERE clause filtered out a row owned by a different
      // user. Surface as a 409 so the endpoint can show "already linked to
      // another account".
      return {
        success: false,
        message: "This account is already linked to a different Puff user.",
        status: 409,
      }
    }
    return {
      success: true,
      linked: rows[0].inserted ? "created" : "updated",
      status: rows[0].inserted ? 201 : 200,
    }
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return {
        success: false,
        message: "This account is already linked to a different Puff user.",
        status: 409,
      }
    }
    console.error("Error in linkExternalIdentity:", error)
    return {
      error: true,
      message: "Could not link identity.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Unlinks an identity. Refuses to remove the last credential — a user must
 * always retain a password, a passkey, or at least one other linked
 * identity, or they would lose all access to the account.
 */
export async function unlinkExternalIdentity(
  dbClient: DbClient,
  user_uuid: string,
  provider: string,
  provider_user_id: string
): Promise<Envelope> {
  try {
    return await runInTransaction(dbClient, async (): Promise<Envelope> => {
      // Other-credential counts. Anything that survives this row's removal
      // qualifies, so we count siblings too.
      const counts = await dbClient.query(
        `SELECT
           (SELECT count(*) FROM secrets
              WHERE user_uuid = $1
                AND secret_type LIKE 'puff_password_%'
                AND is_enabled = TRUE)::INT AS password_count,
           (SELECT count(*) FROM passkeys
              WHERE user_uuid = $1 AND is_enabled = TRUE)::INT AS passkey_count,
           (SELECT count(*) FROM external_identities
              WHERE user_uuid = $1
                AND NOT (provider = $2 AND provider_user_id = $3))::INT AS other_identity_count`,
        [user_uuid, provider, provider_user_id]
      )
      const row = counts.rows[0]
      const remaining = row.password_count + row.passkey_count + row.other_identity_count
      if (remaining <= 0) {
        throw new Rollback<Envelope>({
          success: false,
          message: "Unlinking this provider would leave you with no way to sign in. Set a password or add a passkey first.",
          status: 409,
        })
      }

      const result = await dbClient.query(
        `DELETE FROM external_identities
          WHERE user_uuid = $1 AND provider = $2 AND provider_user_id = $3`,
        [user_uuid, provider, provider_user_id]
      )
      if ((result.rowCount ?? 0) === 0) {
        throw new Rollback<Envelope>({
          success: false,
          message: "Linked identity not found.",
          status: 404,
        })
      }
      return { success: true, status: 200 }
    })
  } catch (error) {
    console.error("Error in unlinkExternalIdentity:", error)
    return {
      error: true,
      message: "Could not unlink identity.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Bumps `last_used_at` on a successful federated login. Non-fatal. */
export async function updateLastUsed(dbClient: DbClient, provider: string, provider_user_id: string): Promise<void> {
  try {
    await dbClient.query(
      `UPDATE external_identities
          SET last_used_at = NOW()
        WHERE provider = $1 AND provider_user_id = $2`,
      [provider, provider_user_id]
    )
  } catch (error) {
    console.error("Error in updateLastUsed (external_identities):", error)
  }
}
