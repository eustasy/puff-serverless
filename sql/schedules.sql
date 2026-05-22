-- Automated row cleanup via CockroachDB Row-Level TTL.
--
-- Pure-data cleanup that used to run in `src/cron.ts` lives here instead:
-- each table carries a TTL storage parameter, and CockroachDB's built-in
-- TTL job deletes expired rows on its own schedule. No Worker invocation,
-- no Hyperdrive connection, no round-trip per DELETE. `src/cron.ts` keeps
-- `runScheduledCleanup` as a manually callable fallback (development,
-- emergencies, or operators on a CockroachDB version too old for this).
--
-- Mechanism: `ttl_expiration_expression` — a per-row SQL expression that
-- evaluates to a TIMESTAMPTZ; the TTL job deletes a row once that time has
-- passed. Returning NULL means "never expires". The expressions below are
-- pure column arithmetic (no `now()`), so each row's expiry is stable.
-- `ttl_job_cron` sets how often the TTL job scans each table.
--
-- Requires CockroachDB v23.1+ (`ttl_expiration_expression`). On older
-- versions, skip this file and run `runScheduledCleanup` from a Worker
-- cron instead — see docs/plans/phase-8-cron.md.
--
-- Idempotent: `ALTER TABLE … SET` just re-applies the same parameters, so
-- re-running this file is safe. To remove a table's TTL: `ALTER TABLE …
-- RESET (ttl)`. To inspect: `SHOW SCHEDULES` lists one row-level-TTL
-- schedule per table; `WITH x AS (SHOW JOBS) SELECT * FROM x WHERE
-- job_type = 'ROW LEVEL TTL'` shows recent runs.

-- TOTP replay-guard rows are only meaningful inside the `verify()`
-- acceptance window (~90s); expire each 2 minutes after `used_at`. Scanned
-- every 5 minutes so a stale row cannot collide with a later code.
ALTER TABLE IF EXISTS public.totp_used_codes SET (
  ttl_expiration_expression = 'used_at::TIMESTAMPTZ + INTERVAL ''2 minutes''',
  ttl_job_cron = '*/5 * * * *'
);

-- Floating-licence pool: each row carries its own `expires_at` (set when
-- the access token was minted). A row past that has lost its licence claim
-- and must free the slot — so the row expires exactly at `expires_at`.
-- Scanned every 5 minutes so a pool slot is never held long after expiry.
ALTER TABLE IF EXISTS public.app_floating_sessions SET (
  ttl_expiration_expression = 'expires_at::TIMESTAMPTZ',
  ttl_job_cron = '*/5 * * * *'
);

-- Sessions are kept a month as a lightweight audit trail, then purged only
-- when also defunct. The expression encodes that without `now()`:
--   * inactive          -> expire at created_at + 1 month
--   * past its own expiry -> expire at max(expires_at, created_at + 1 month)
--   * still valid       -> NULL (never expire), even if SESSION_MAX_AGE was
--                          raised beyond a month
ALTER TABLE IF EXISTS public.sessions SET (
  ttl_expiration_expression =
    'CASE
       WHEN is_active = false
         THEN created_at::TIMESTAMPTZ + INTERVAL ''1 month''
       WHEN expires_at IS NOT NULL
         THEN greatest(expires_at::TIMESTAMPTZ, created_at::TIMESTAMPTZ + INTERVAL ''1 month'')
       ELSE NULL
     END',
  ttl_job_cron = '0 * * * *'
);

-- Tokens expire within 24h, so a month-old row is always long defunct.
ALTER TABLE IF EXISTS public.tokens SET (
  ttl_expiration_expression = 'created_at::TIMESTAMPTZ + INTERVAL ''1 month''',
  ttl_job_cron = '0 * * * *'
);

-- Tier audit retention by severity: `info`/`debug` are routine observability
-- rows safe to drop after a quarter; `notice` and above (member changes,
-- password changes, deletions) return NULL so they are kept indefinitely
-- and the security-relevant timeline never gaps.
ALTER TABLE IF EXISTS public.audit_events SET (
  ttl_expiration_expression =
    'CASE
       WHEN event_severity IN (''debug'', ''info'')
         THEN created_at::TIMESTAMPTZ + INTERVAL ''90 days''
       ELSE NULL
     END',
  ttl_job_cron = '0 * * * *'
);
