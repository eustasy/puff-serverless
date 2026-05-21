// Scheduled cleanup.
//
// This is the one code path with no `_middleware.ts` in front of it, so —
// unlike every other `src/` module, which receives `dbClient` as its first
// parameter — this module opens and closes its own `pg` client.
//
// It is driven by the Cloudflare Cron Triggers declared in `wrangler.jsonc`
// and the `scheduled` handler wired into the Worker entry (`worker.ts`):
//
//   "*/5 * * * *"  Purge `totp_used_codes`. This must run far more often than
//                  the audit purge: a row only guards against replay while its
//                  code is still inside the `verify()` acceptance window
//                  (~90s). Left longer, a stale row can collide with a later,
//                  legitimately-different code that happens to match the same
//                  six digits — a false replay rejection. Frequent pruning
//                  keeps that window short. Also reaps `app_floating_sessions`
//                  past their `expires_at` so a floating-licence pool slot is
//                  never permanently held by a session whose access token
//                  expired without an explicit release.
//   "0 * * * *"    Additionally purge `sessions` and `tokens`. These are kept
//                  for a month first: a defunct session or token row is a
//                  lightweight audit record of a login or a reset request.

import { Client } from "pg"

// `totp_used_codes` rows matter only while the code is still inside its
// `verify()` acceptance window; a small margin past that is plenty.
const TOTP_RETENTION = "2 minutes"

// `sessions` / `tokens` are retained as a month-long audit trail before purge.
const AUDIT_RETENTION = "1 month"

// The cron expression of the hourly trigger; the others only run the TOTP purge.
const HOURLY_CRON = "0 * * * *"

/**
 * Cron Trigger entry point. Re-exported as the Worker's `scheduled` handler
 * via `worker.ts`.
 */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(runScheduledCleanup(env, controller.cron))
}

/**
 * Reaps rows the request path only ever soft-expires (sessions are marked
 * inactive, tokens marked used) but never deletes. The `cron` argument selects
 * how much runs — see the schedule table at the top of this file.
 *
 * Never throws: a cron invocation has no caller to surface an error to, so a
 * failure is logged and the next run retries.
 */
export async function runScheduledCleanup(
  env: Env,
  cron: string
): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) {
    console.error("Scheduled cleanup: HYPERDRIVE binding missing; skipping.")
    return
  }

  const client = new Client(env.HYPERDRIVE.connectionString)
  try {
    await client.connect()

    const totp = await client.query(
      "DELETE FROM totp_used_codes WHERE used_at < NOW() - $1::INTERVAL",
      [TOTP_RETENTION]
    )
    // Floating-seat rows are reaped every tick: each row has its own
    // `expires_at` (set when the access token was minted, ~1h ahead), so any
    // row past that time has lost its license claim and must free the slot.
    const floating = await client.query(
      "DELETE FROM app_floating_sessions WHERE expires_at <= NOW()"
    )
    let summary = `${totp.rowCount ?? 0} TOTP codes, ${floating.rowCount ?? 0} floating seats`

    if (cron === HOURLY_CRON) {
      // The defunct guard (inactive / past expiry) means a still-valid session
      // is never purged even if an operator has raised SESSION_MAX_AGE_SECONDS
      // beyond the audit window. Tokens expire within 24h, so a month-old row
      // is always long defunct — no guard needed.
      const sessions = await client.query(
        `DELETE FROM sessions
           WHERE created_at < NOW() - $1::INTERVAL
             AND (is_active = FALSE OR (expires_at IS NOT NULL AND expires_at < NOW()))`,
        [AUDIT_RETENTION]
      )
      const tokens = await client.query(
        "DELETE FROM tokens WHERE created_at < NOW() - $1::INTERVAL",
        [AUDIT_RETENTION]
      )
      summary += `, ${sessions.rowCount ?? 0} sessions, ${tokens.rowCount ?? 0} tokens`
    }

    console.log(`Scheduled cleanup (${cron}): purged ${summary}.`)
  } catch (error) {
    console.error("Scheduled cleanup failed:", error)
  } finally {
    try {
      await client.end()
    } catch (endError) {
      console.error("Scheduled cleanup: error closing DB client:", endError)
    }
  }
}
