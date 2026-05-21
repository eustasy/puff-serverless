// Scheduled work that runs in the Worker.
//
// This is the one code path with no `_middleware.ts` in front of it, so —
// unlike every other `src/` module, which receives `dbClient` as its first
// parameter — this module opens and closes its own `pg` client when it needs
// the database.
//
// It is driven by the Cloudflare Cron Triggers declared in `wrangler.jsonc`
// and the `scheduled` handler wired into the Worker entry (`worker.ts`).
//
// Two kinds of periodic work in the system, and they live in different
// places by design:
//
//   * Pure-SQL row reaping (TOTP / floating-session / session / token /
//     audit cleanup) runs in CockroachDB itself via `CREATE SCHEDULE … FOR
//     SQL` — see `sql/schedules.sql`. No Worker invocation, no Hyperdrive
//     handshake, no round-trip per DELETE. `runScheduledCleanup` below is
//     kept as a manually-callable fallback (development, emergencies, or
//     operators on a CockroachDB version that does not support the DDL).
//   * Work that needs Web Crypto, or that calls an external API, runs here.
//     Currently: OAuth signing-key rotation.
//
//   "0 0 * * *"  Daily tick. Calls `maybeRotateSigningKey`, which rotates
//                only once the active key is older than
//                `OAUTH_KEY_ROTATION_INTERVAL_DAYS` (default 7) — so the
//                effective rotation cadence is weekly.

import { Client } from "pg"
import { maybeRotateSigningKey } from "./oauth-keys-rotation.js"

// `totp_used_codes` rows matter only while the code is still inside its
// `verify()` acceptance window; a small margin past that is plenty.
const TOTP_RETENTION = "2 minutes"

// `sessions` / `tokens` are retained as a month-long audit trail before purge.
const AUDIT_RETENTION = "1 month"

// Low-severity audit events (info/debug) age out after this; higher
// severities are retained indefinitely so the security-relevant timeline
// stays intact regardless of how long ago an incident happened.
const AUDIT_LOW_SEVERITY_RETENTION = "90 days"

/**
 * Cron Trigger entry point. Re-exported as the Worker's `scheduled` handler
 * via `worker.ts`. Dispatches by cron expression so adding a future trigger
 * is just one more branch.
 */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(runScheduledWork(env, controller.cron))
}

async function runScheduledWork(env: Env, cron: string): Promise<void> {
  try {
    await maybeRotateSigningKey(env, { cron })
  } catch (error) {
    console.error(`Scheduled work (${cron}) failed:`, error)
  }
}

/**
 * Reaps rows the request path only ever soft-expires (sessions are marked
 * inactive, tokens marked used) but never deletes. Each query mirrors a
 * CockroachDB-side schedule from `sql/schedules.sql`; this function exists
 * so operators can run the same purges manually (e.g. from a Node REPL
 * during incident response, or on a CockroachDB version that does not
 * support `CREATE SCHEDULE FOR SQL`).
 *
 * Never throws: a cron invocation has no caller to surface an error to, so
 * a failure is logged and the next run retries.
 */
export async function runScheduledCleanup(env: Env): Promise<void> {
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
    const floating = await client.query(
      "DELETE FROM app_floating_sessions WHERE expires_at <= NOW()"
    )
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
    const auditEvents = await client.query(
      `DELETE FROM audit_events
         WHERE event_severity IN ('debug', 'info')
           AND created_at < NOW() - $1::INTERVAL`,
      [AUDIT_LOW_SEVERITY_RETENTION]
    )

    console.log(
      `Scheduled cleanup: purged ` +
        `${totp.rowCount ?? 0} TOTP codes, ` +
        `${floating.rowCount ?? 0} floating seats, ` +
        `${sessions.rowCount ?? 0} sessions, ` +
        `${tokens.rowCount ?? 0} tokens, ` +
        `${auditEvents.rowCount ?? 0} audit events.`
    )
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
