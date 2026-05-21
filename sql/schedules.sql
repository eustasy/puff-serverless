-- CockroachDB scheduled SQL jobs.
--
-- Pure-data cleanup that used to run in `src/cron.ts` lives here instead:
-- the database runs the DELETE itself, so each tick costs one query rather
-- than a Worker invocation, a fresh Hyperdrive `pg` connection, and a
-- round-trip. `src/cron.ts` keeps `runScheduledCleanup` as a manually
-- callable fallback (development, emergencies, or operators on a CockroachDB
-- version that does not support `CREATE SCHEDULE FOR SQL`).
--
-- Requires CockroachDB v23.1+ (`CREATE SCHEDULE … FOR SQL`). On older
-- versions, keep the Worker cron handling these queries — see
-- docs/plans/phase-8-cron.md.
--
-- Idempotent. `IF NOT EXISTS` means re-applying this file leaves existing
-- schedules untouched; to change a schedule's expression or SQL, drop the
-- old one explicitly (`DROP SCHEDULE puff_…;`) and re-run. `SHOW SCHEDULES`
-- lists what's currently installed; `SHOW JOBS WHERE schedule_id IS NOT NULL`
-- shows recent runs.
--
-- All schedules use the default `ON_EXECUTION_FAILURE = RETRY` for FOR-SQL
-- schedules: a failed run retries on the next tick rather than pausing.

-- TOTP replay-guard rows are only meaningful inside the `verify()`
-- acceptance window (~90s). A small margin past that is plenty.
CREATE SCHEDULE IF NOT EXISTS puff_purge_totp_used_codes
  FOR SQL
  WITH SCHEDULE OPTIONS first_run = 'now'
  RECURRING '*/5 * * * *'
  EXECUTE SQL $$
    DELETE FROM totp_used_codes WHERE used_at < NOW() - INTERVAL '2 minutes'
  $$;

-- Floating-licence pool: each row carries its own `expires_at` (set when
-- the access token was minted, ~1h ahead). Any row past that has lost its
-- licence claim and must free the slot.
CREATE SCHEDULE IF NOT EXISTS puff_purge_app_floating_sessions
  FOR SQL
  WITH SCHEDULE OPTIONS first_run = 'now'
  RECURRING '*/5 * * * *'
  EXECUTE SQL $$
    DELETE FROM app_floating_sessions WHERE expires_at <= NOW()
  $$;

-- Sessions are kept a month as a lightweight audit trail, then purged
-- only when also defunct (inactive or past expiry) so a still-valid
-- session is never deleted even if SESSION_MAX_AGE_SECONDS is raised
-- beyond the audit window.
CREATE SCHEDULE IF NOT EXISTS puff_purge_sessions
  FOR SQL
  WITH SCHEDULE OPTIONS first_run = 'now'
  RECURRING '0 * * * *'
  EXECUTE SQL $$
    DELETE FROM sessions
      WHERE created_at < NOW() - INTERVAL '1 month'
        AND (is_active = FALSE OR (expires_at IS NOT NULL AND expires_at < NOW()))
  $$;

-- Tokens expire within 24h, so a month-old row is always long defunct.
CREATE SCHEDULE IF NOT EXISTS puff_purge_tokens
  FOR SQL
  WITH SCHEDULE OPTIONS first_run = 'now'
  RECURRING '0 * * * *'
  EXECUTE SQL $$
    DELETE FROM tokens WHERE created_at < NOW() - INTERVAL '1 month'
  $$;

-- Tier audit retention by severity: `info`/`debug` are routine observability
-- rows safe to drop after a quarter; `notice` and above (member changes,
-- password changes, deletions) are kept indefinitely so the security-relevant
-- timeline never gaps.
CREATE SCHEDULE IF NOT EXISTS puff_purge_audit_low_severity
  FOR SQL
  WITH SCHEDULE OPTIONS first_run = 'now'
  RECURRING '0 * * * *'
  EXECUTE SQL $$
    DELETE FROM audit_events
      WHERE event_severity IN ('debug', 'info')
        AND created_at < NOW() - INTERVAL '90 days'
  $$;
