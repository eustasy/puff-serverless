// Floating-license concurrent-seat tracking. Used only for apps where
// `app_licensing_mode = 'floating'`: a per-org pool of N seats is dynamically
// allocated as users access the app, freed when their access tokens expire,
// and never assigned ahead of time. Each row in `app_floating_sessions`
// represents one user currently holding a seat from one org's pool.
//
// A user holding multiple concurrent OAuth tokens against the same app under
// the same org counts as one seat (the row is bumped, not added). Different
// orgs have independent pools.

import { runInTransaction, Rollback } from "./utilities/transaction.js"
import { LICENSE_FLOATING_MAX_KEY } from "./apps.js"

/** Default seat lifetime — aligned with the OAuth access-token TTL (1 hour). */
export const DEFAULT_FLOATING_SEAT_TTL_SECONDS = 60 * 60

/**
 * Reads the pool size for `(app, org)`. Checks the org's specifically-set
 * `license:floating:max` first (in `organisation_key_values`, subject=org,
 * owner=app), then falls back to the app's globally-declared default (in
 * `app_key_values`, subject=app, owner=app). Returns null when neither is set
 * — the caller treats that as a closed pool (no allocation allowed).
 */
export async function getFloatingPoolMax(
  dbClient: DbClient,
  app_uuid: string,
  org_uuid: string
): Promise<Envelope<{ max: number | null }>> {
  try {
    const orgScoped = await dbClient.query(
      `SELECT kv_value FROM organisation_key_values
        WHERE org_uuid = $1 AND owner_app_uuid = $2 AND kv_key = $3
        LIMIT 1`,
      [org_uuid, app_uuid, LICENSE_FLOATING_MAX_KEY]
    )
    const raw =
      orgScoped.rows[0]?.kv_value ??
      (
        await dbClient.query(
          `SELECT kv_value FROM app_key_values
            WHERE app_uuid = $1 AND owner_app_uuid = $1 AND kv_key = $2
            LIMIT 1`,
          [app_uuid, LICENSE_FLOATING_MAX_KEY]
        )
      ).rows[0]?.kv_value
    if (raw === undefined) {
      return { success: true, max: null, status: 200 }
    }
    const max = Number.parseInt(raw, 10)
    if (!Number.isFinite(max) || max < 0) {
      return { success: true, max: null, status: 200 }
    }
    return { success: true, max, status: 200 }
  } catch (error) {
    console.error("Error in getFloatingPoolMax:", error)
    return {
      error: true,
      message: "Could not read floating pool size.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Active (not-yet-expired) seat count for `(app, org)`. */
export async function countActiveFloatingSeats(
  dbClient: DbClient,
  app_uuid: string,
  org_uuid: string
): Promise<Envelope<{ count: number }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT count(*)::INT AS count
         FROM app_floating_sessions
        WHERE app_uuid = $1 AND org_uuid = $2 AND expires_at > NOW()`,
      [app_uuid, org_uuid]
    )
    return { success: true, count: rows[0]?.count ?? 0, status: 200 }
  } catch (error) {
    console.error("Error in countActiveFloatingSeats:", error)
    return {
      error: true,
      message: "Could not count floating seats.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Allocate (or bump) a floating seat for `(app, org, user)`. If the user
 * already holds a seat in this pool, the row is updated in-place — no extra
 * seat is consumed. If they do not, the pool's current usage is compared to
 * its max; an empty pool max means "closed" and the allocation is refused.
 *
 * Returns `{success: true, allocated: 'new' | 'existing', expires_at}` on
 * success. Returns `{success: false, status: 409, message: '...'}` on a
 * pool-exhausted result; callers map that to an OAuth `access_denied`.
 *
 * SERIALIZABLE: the count-then-insert is in a transaction, so two concurrent
 * allocations cannot both squeeze into the last slot.
 */
export async function checkoutFloatingSeat(
  dbClient: DbClient,
  app_uuid: string,
  org_uuid: string,
  user_uuid: string,
  ttl_seconds: number = DEFAULT_FLOATING_SEAT_TTL_SECONDS
): Promise<
  Envelope<{
    allocated: "new" | "existing"
    expires_at: Date
  }>
> {
  type Result = Envelope<{ allocated: "new" | "existing"; expires_at: Date }>
  try {
    return await runInTransaction(dbClient, async (): Promise<Result> => {
      const existing = await dbClient.query(
        `SELECT 1 FROM app_floating_sessions
          WHERE app_uuid = $1 AND org_uuid = $2 AND user_uuid = $3
          LIMIT 1`,
        [app_uuid, org_uuid, user_uuid]
      )
      const isExisting = (existing.rowCount ?? 0) > 0

      if (!isExisting) {
        const poolMax = await getFloatingPoolMax(dbClient, app_uuid, org_uuid)
        if (!poolMax.success) {
          throw new Rollback<Result>({
            error: true,
            message: poolMax.message,
            status: poolMax.status,
          })
        }
        if (poolMax.max === null) {
          throw new Rollback<Result>({
            success: false,
            message:
              "No floating-licence pool is configured for this app in this organisation.",
            status: 409,
          })
        }
        const max = poolMax.max
        const usage = await dbClient.query(
          `SELECT count(*)::INT AS count
             FROM app_floating_sessions
            WHERE app_uuid = $1 AND org_uuid = $2 AND expires_at > NOW()`,
          [app_uuid, org_uuid]
        )
        const current = usage.rows[0]?.count ?? 0
        if (current >= max) {
          throw new Rollback<Result>({
            success: false,
            message: "Floating-licence pool is fully allocated.",
            status: 409,
          })
        }
      }

      const upsert = await dbClient.query(
        `INSERT INTO app_floating_sessions
            (app_uuid, org_uuid, user_uuid, heartbeat_at, expires_at)
          VALUES
            ($1, $2, $3, NOW(), NOW() + ($4 || ' seconds')::INTERVAL)
          ON CONFLICT (app_uuid, org_uuid, user_uuid) DO UPDATE
            SET heartbeat_at = NOW(),
                expires_at = NOW() + ($4 || ' seconds')::INTERVAL
          RETURNING expires_at`,
        [app_uuid, org_uuid, user_uuid, ttl_seconds]
      )
      return {
        success: true,
        allocated: isExisting ? "existing" : "new",
        expires_at: upsert.rows[0].expires_at,
        status: 200,
      }
    })
  } catch (error) {
    console.error("Error in checkoutFloatingSeat:", error)
    return {
      error: true,
      message: "Could not allocate floating seat.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Bumps `heartbeat_at` / `expires_at` for an already-allocated seat. Does
 * nothing (returns `existing: false`) if no row matches — the caller can
 * decide whether that is a problem or just race with a cleanup.
 */
export async function heartbeatFloatingSeat(
  dbClient: DbClient,
  app_uuid: string,
  org_uuid: string,
  user_uuid: string,
  ttl_seconds: number = DEFAULT_FLOATING_SEAT_TTL_SECONDS
): Promise<Envelope<{ existing: boolean }>> {
  try {
    const result = await dbClient.query(
      `UPDATE app_floating_sessions
          SET heartbeat_at = NOW(),
              expires_at = NOW() + ($4 || ' seconds')::INTERVAL
        WHERE app_uuid = $1 AND org_uuid = $2 AND user_uuid = $3`,
      [app_uuid, org_uuid, user_uuid, ttl_seconds]
    )
    return {
      success: true,
      existing: (result.rowCount ?? 0) > 0,
      status: 200,
    }
  } catch (error) {
    console.error("Error in heartbeatFloatingSeat:", error)
    return {
      error: true,
      message: "Could not heartbeat floating seat.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Removes any seat the user holds in `(app, org)`. Idempotent. */
export async function releaseFloatingSeat(
  dbClient: DbClient,
  app_uuid: string,
  org_uuid: string,
  user_uuid: string
): Promise<Envelope<{ released: boolean }>> {
  try {
    const result = await dbClient.query(
      `DELETE FROM app_floating_sessions
        WHERE app_uuid = $1 AND org_uuid = $2 AND user_uuid = $3`,
      [app_uuid, org_uuid, user_uuid]
    )
    return {
      success: true,
      released: (result.rowCount ?? 0) > 0,
      status: 200,
    }
  } catch (error) {
    console.error("Error in releaseFloatingSeat:", error)
    return {
      error: true,
      message: "Could not release floating seat.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Deletes every seat whose `expires_at` has passed. Called from the
 * scheduled cleanup job to free orphan allocations whose access tokens have
 * expired without being explicitly released.
 */
export async function reapStaleFloatingSessions(
  dbClient: DbClient
): Promise<Envelope<{ reaped: number }>> {
  try {
    const result = await dbClient.query(
      `DELETE FROM app_floating_sessions WHERE expires_at <= NOW()`
    )
    return { success: true, reaped: result.rowCount ?? 0, status: 200 }
  } catch (error) {
    console.error("Error in reapStaleFloatingSessions:", error)
    return {
      error: true,
      message: "Could not reap floating sessions.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
