# Phase 8 — Cron infrastructure

Two parallel tracks of work on the periodic-task layer. Plan A pushes the existing pure-SQL cleanup jobs **out** of `src/cron.ts` and into the database itself, so they don't need a Worker invocation per tick. Plan B adds a **new** Worker-driven cron — automated OAuth signing-key rotation — that has to stay in the Worker because it needs Web Crypto. The two land independently; doing both leaves `src/cron.ts` smaller, more focused, and with a clearer "what stays in code, what runs in the DB" split.

> **Status: implemented.** Both plans have landed in code. Checkboxes below are ticked for code-complete items; the deploy-time steps in [Migration from the env-var scheme](#migration-from-the-env-var-scheme) remain unticked because they run against a live environment, not the repo. Deltas from the plan as written:
>
> - The audit tier-1 reap runs **hourly**, not nightly — folded into the existing hourly schedule rather than given its own cadence.
> - The optional `GET /api/db/auth/admin/schedules` observability endpoint was **not** built; `SHOW SCHEDULES` / `SHOW JOBS` is documented in `docs/Operations.md` instead.
> - `functions/.well-known/jwks.json.ts` needed **no direct change** — it calls `currentPublicJwk` / `previousPublicJwk`, and the KV read moved entirely inside `src/oauth-keys.ts`.
> - Rollback ships as **two** operator endpoints: `POST /api/db/auth/admin/oauth-keys/rotate` (force-rotate) and `POST /api/db/auth/admin/oauth-keys/promote-retired` (swap retired back to active). Both gated by a new `OPERATOR_USER_UUIDS` env var via `functions/api/db/auth/admin/_middleware.ts`.
> - The KV-read cache is populated **only on the KV path**, not the env-var fallback — caching the cheap in-memory `JSON.parse` gave no benefit and caused cross-env bleed.

## Table of Contents

- [Context](#context)
- [Plan A — SQL cleanup → CockroachDB scheduled jobs](#plan-a--sql-cleanup--cockroachdb-scheduled-jobs)
- [Plan B — Automated OAuth signing-key rotation](#plan-b--automated-oauth-signing-key-rotation)
- [Combined cron landscape after both plans](#combined-cron-landscape-after-both-plans)
- [Migration order](#migration-order)
- [Open decisions — resolved](#open-decisions--resolved)
- [Out of scope](#out-of-scope)

## Context

Today `src/cron.ts` runs every periodic task in the system. Two Cloudflare Cron Triggers (`*/5 * * * *` and `0 * * * *`) invoke the `scheduled` handler, which opens its own `pg` client and runs five `DELETE` statements between them. All of them are pure SQL — there is no application logic, no external API call, no Web Crypto. Every tick incurs:

- A Worker invocation (cold start possible).
- A fresh Hyperdrive `pg` connection (TLS handshake amortised by the pool but still real).
- A round-trip per `DELETE`.
- Cloudflare bills the Worker invocation; CockroachDB bills the queries.

Meanwhile, the OAuth signing-key rotation procedure (`docs/Operations.md → OAuth signing-key rotation`) is **manual**. The operator must remember to do it, get the three-step sequence right, and time the overlap-window cleanup. Easy to forget, no audit trail, single-person dependency. Rotating keys is exactly the kind of work a cron should do.

## Plan A — SQL cleanup → CockroachDB scheduled jobs

CockroachDB has supported [`CREATE SCHEDULE … FOR SQL`](https://www.cockroachlabs.com/docs/stable/create-schedule-for-sql) since v23.1, letting the database run an arbitrary SQL statement on a cron schedule. The Worker no longer needs to be the orchestrator for pure-data-cleanup work.

### What moves

Every current `src/cron.ts` query is in scope. Each becomes one DB-side schedule:

- [x] **TOTP replay cleanup** — `DELETE FROM totp_used_codes WHERE used_at < NOW() - INTERVAL '2 minutes'`. Every 5 minutes.
- [x] **Floating-seat reap** — `DELETE FROM app_floating_sessions WHERE expires_at <= NOW()`. Every 5 minutes.
- [x] **Session purge** — `DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '1 month' AND (is_active = FALSE OR (expires_at IS NOT NULL AND expires_at < NOW()))`. Hourly.
- [x] **Token purge** — `DELETE FROM tokens WHERE created_at < NOW() - INTERVAL '1 month'`. Hourly.
- [x] **Audit log tier-1 reap** — `DELETE FROM audit_events WHERE event_severity IN ('debug', 'info') AND created_at < NOW() - INTERVAL '90 days'`. Hourly.

### Schema (`sql/schedules.sql`)

- [x] Add `sql/schedules.sql` as the version-controlled source of truth. Each schedule is a `CREATE SCHEDULE IF NOT EXISTS` so re-applying is idempotent.
- [x] Name schedules consistently: `puff_purge_totp_used_codes`, `puff_purge_app_floating_sessions`, `puff_purge_sessions`, `puff_purge_tokens`, `puff_purge_audit_low_severity`.
- [x] Set the per-schedule options: `ON_EXECUTION_FAILURE = RETRY` (CockroachDB default behaviour for `FOR SQL`); `IGNORE_EXISTING_BACKUPS` doesn't apply. Document the version assumption (CockroachDB ≥ v23.1) in the file header.

### Worker changes

- [x] Remove the five queries from `src/cron.ts`'s `scheduled` path. The Worker's `scheduled` handler now only runs `maybeRotateSigningKey` (Plan B).
- [x] Once Plan A and Plan B both ship, decide whether to keep the Cloudflare Cron Triggers at all. **Decision:** keep one trigger — the daily `0 0 * * *` — which Plan B's rotation needs. The `*/5` and hourly triggers are gone.
- [x] Keep `runScheduledCleanup` around as a callable function for **manual** purges. Retained in `src/cron.ts`; runs all five DELETEs in one pass. Useful for development and emergency operations even when the DB schedules are doing the routine work.

### Observability changes

| Now                                                                                  | After                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare worker tail shows `Scheduled cleanup (0 * * * *): purged …` summary line. | `SHOW SCHEDULES` lists the registered jobs; `SHOW JOBS WHERE schedule_id IS NOT NULL` shows history; `SHOW JOB <id>` shows per-run rowcounts and errors. |
| Errors surface in Cloudflare logs.                                                   | Errors surface in CockroachDB jobs and the schedule's status.                                                                                            |

- [x] Document the new observability surface in `docs/Operations.md → Scheduled cleanup`.
- [ ] Optional: add an operator endpoint `GET /api/db/auth/admin/schedules` that runs `SHOW SCHEDULES` + the recent `SHOW JOBS` and renders the result. **Not built** — the `SHOW SCHEDULES` / `SHOW JOBS` queries are documented in `docs/Operations.md` for operators to run directly. Could still be added later.

### Risks and mitigations

| Risk                                       | Mitigation                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CockroachDB version too old for `FOR SQL`. | Deployment doc lists v23.1+ as a prerequisite for Plan A. Existing operators on older versions can either upgrade or keep `src/cron.ts` as-is for those tasks.                                                               |
| Schedule fails silently.                   | `SHOW SCHEDULES` reveals last run + last status; the operator endpoint surfaces it. Set up an alert on any schedule with `next_run < now() - interval '15 minutes'`.                                                         |
| Schedule DDL is privileged.                | Document in `docs/Deployment.md` that schedule installation needs an admin role; provide the exact `GRANT` if needed.                                                                                                        |
| Need to roll back to Worker cron.          | `src/cron.ts` retains all the queries until both Plan A and Plan B are stable in production. Removing them is the final step, not the first.                                                                                 |
| Cross-engine portability.                  | Schedules are CockroachDB-specific. If you ever move to a different Postgres-compatible DB without `CREATE SCHEDULE FOR SQL`, the Worker cron is the fallback — which is why we don't delete `runScheduledCleanup` outright. |

## Plan B — Automated OAuth signing-key rotation

Today rotation is a manual three-step operator dance: generate, install previous-public, install new private, wait for overlap, clear previous-public. Plan B automates the whole thing on a cron. The signing material lives in **Cloudflare KV** (writable from the Worker; not a database), not in Wrangler secrets (immutable to the running runtime).

### Storage

- [x] Add a KV namespace `KV_OAUTH_KEYS` to `wrangler.jsonc`.
- [x] Two KV entries:
  - `oauth:keys:active` — `{ jwk: <private JWK>, kid, created_at }`. The current signer.
  - `oauth:keys:retired` — `{ jwk: <public JWK>, kid, retired_at }`. Held during the overlap window. **Stored with `expirationTtl`** so it self-cleans after the overlap (2 hours = 1h longest-TTL + 1h safety margin).

### Cron handler

- [x] New entry in `src/cron.ts` for the rotation tick. `wrangler.jsonc` `triggers.crons` is `0 0 * * *` (daily); the `scheduled` handler calls `maybeRotateSigningKey`, which rotates only when the active key is older than the interval — effective cadence weekly.
- [x] New module `src/oauth-keys-rotation.ts` exporting `rotateSigningKey(env)` (plus `maybeRotateSigningKey` and `promoteRetiredKey`):
  1. Generate a fresh ES256 keypair in-Worker (same logic as `scripts/generate-oauth-key.mjs`, ported).
  2. Validate the new key by signing and verifying a test payload — bail without promoting if anything fails.
  3. Read the current `oauth:keys:active`. If present, write its **public-only** form to `oauth:keys:retired` with `expirationTtl: 7200`. The private half of the retiring key is discarded — there is no use for it past this point.
  4. Write the new key to `oauth:keys:active`.
  5. Emit `oauth.signing_key.rotated` (severity `alert`) with metadata `{ new_kid, retired_kid }`.

### Runtime path changes

- [x] `src/oauth-keys.ts`:
  - `loadSigningKey(env)` reads from KV, falling back to `env.OAUTH_SIGNING_KEY_PRIVATE` while KV is empty (migration).
  - Module-level cache with a fixed TTL (60s), populated **only on the KV path**. Acceptable lag: signing momentarily with the previous-active is fine because that key is in JWKS as the retired entry, so JWTs still verify.
  - `currentPublicJwk(env)` / `previousPublicJwk(env)` both read from KV (with the same env-var fallback).
- [x] `functions/.well-known/jwks.json.ts` serves both entries. **No direct change** — it already calls `currentPublicJwk` / `previousPublicJwk`, and the KV read moved entirely inside `src/oauth-keys.ts`.

### Migration from the env-var scheme

One-off operator step at deploy:

- [ ] Provision the KV namespace; capture its ID in `wrangler.jsonc`.
- [ ] Seed `oauth:keys:active` with the current `OAUTH_SIGNING_KEY_PRIVATE` value via `wrangler kv:key put`. Same JWK; same `kid`; no rotation event yet.
- [ ] (Optional) seed `oauth:keys:retired` with `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` if you happen to be mid-rotation. Otherwise leave it absent.
- [ ] Deploy. The Worker now reads from KV; the env vars become dead and can be removed in a follow-up deploy after a few cron cycles prove the new path.

### Safety and rollback

| Concern                                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cron crashes mid-rotation.                            | Each KV put is independent. Partial state (retired written but not yet active) is non-fatal: signing continues with the now-also-retired key; the next cron tick re-rotates cleanly.                                                                                                                                                                                        |
| Bad keypair generated.                                | Sign-and-verify test payload before promoting. Bail on failure; active stays in place.                                                                                                                                                                                                                                                                                      |
| Broken-rotation rollback.                             | **Shipped:** option (b) — `POST /api/db/auth/admin/oauth-keys/promote-retired` swaps active and retired. Note the standard rotation strips the private `d` from the retired entry, so promote-retired only restores a _signing_ key when an operator has manually seeded a private retired entry; otherwise `POST .../rotate` (force a fresh keypair) is the recovery path. |
| KV eventual consistency.                              | ~60s lag globally for KV reads. Public keys can be slightly stale because the previous key is still in JWKS. Signing path is similarly tolerant (signs with whichever active the cache holds; verifies anywhere).                                                                                                                                                           |
| Multiple Worker instances see different keys briefly. | Some sign with K1, others with K2. Both are in JWKS during overlap. Tokens verify regardless.                                                                                                                                                                                                                                                                               |
| Cron itself is compromised.                           | Worse than manual rotation — an attacker who can run code in the Worker can also exfiltrate keys. The KV approach doesn't change this. (Mitigation: signing in a separate KMS / external service; out of scope.)                                                                                                                                                            |

### Configuration

- [x] `OAUTH_KEY_ROTATION_INTERVAL_DAYS` env var, default `7`. `maybeRotateSigningKey` uses it to decide whether to rotate on this tick — the daily cron fires more often than the rotation interval and only rotates when the active key is older than the threshold, giving an effective weekly cadence. A manually-triggered extra tick won't rotate prematurely.

## Combined cron landscape after both plans

| Where                    | Schedule            | Runs                                                                           |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------ |
| CockroachDB              | `*/5 * * * *`       | `DELETE FROM totp_used_codes …`, `DELETE FROM app_floating_sessions …`         |
| CockroachDB              | `0 * * * *`         | `DELETE FROM sessions …`, `DELETE FROM tokens …`, `DELETE FROM audit_events …` |
| Worker (CF Cron Trigger) | `0 0 * * *` (daily) | `maybeRotateSigningKey(env)` — rotates weekly (7-day age gate)                 |

Three triggers across two systems, each running exactly what it's best at:

- DB-resident DELETEs run **in** the database — no network round-trip, no Worker invocation.
- Web-Crypto key generation runs **in** the Worker — where Web Crypto is available.

## Migration order

Land Plan A and Plan B independently; either order works, but Plan A first is gentler because nothing about Plan A changes the live behaviour visible to users.

1. **Plan A, phase 1 — co-existence.** Install `sql/schedules.sql` on the live DB. The schedules and the Worker cron both run the same DELETEs; the rows that satisfy the WHERE clause get deleted once (either by whichever ran first) and the other is a no-op. Verify in `SHOW SCHEDULES` and `wrangler tail` for one full cycle (≥ a week).
2. **Plan A, phase 2 — cutover.** Remove the SQL DELETEs from `src/cron.ts`; the Worker cron now does nothing except prepare for Plan B. Watch DB-side `SHOW JOBS` for the next cycle.
3. **Plan B, phase 1 — KV seed + dual-read.** Provision the KV namespace, seed `oauth:keys:active` from the existing env var, deploy a `src/oauth-keys.ts` that **prefers KV but falls back to the env var** if KV is empty. Production traffic now reads from KV; the env var is a safety net.
4. **Plan B, phase 2 — enable rotation.** Add the daily cron-trigger entry. Watch the first rotation cycle end-to-end (`audit_events` for the `oauth.signing_key.rotated` event; JWKS for both keys present; old key disappearing from KV after `expirationTtl`).
5. **Plan B, phase 3 — clean up the env-var fallback.** After ≥ one successful rotation, drop the env-var read path and remove the `OAUTH_SIGNING_KEY_PRIVATE` / `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` bindings.

If Plan A is skipped (CockroachDB version too old), Plan B still lands cleanly — they're independent.

## Open decisions — resolved

- [x] **Rotation interval.** Cron is daily (`0 0 * * *`) everywhere; the `OAUTH_KEY_ROTATION_INTERVAL_DAYS` env var (default `7`) is the actual cadence knob — the daily tick rotates only when the active key is older than the interval, so the default is weekly rotation. Firing the cron more often than the interval keeps rotation prompt without depending on exact clock timing. Staging rehearsals go through `POST /api/db/auth/admin/oauth-keys/rotate`.
- [x] **Keep a Worker cron heartbeat?** **No.** No heartbeat trigger added — the daily rotation cron is the only Worker trigger. DB-schedule liveness is observed via `SHOW SCHEDULES` (overdue if `next_run` is well in the past).
- [x] **Manual-promote endpoint for Plan B.** Shipped alongside the cron — `POST /api/db/auth/admin/oauth-keys/promote-retired`, plus a force-rotate endpoint.
- [x] **Audit-event severity for failed rotation.** `oauth.signing_key.rotation.failed` is `critical`; `oauth.signing_key.rotated` and `oauth.signing_key.retired.promoted` are `alert`.

## Out of scope

- **Self-managed CockroachDB schedule observability**. Operators run `SHOW SCHEDULES` / `SHOW JOBS` directly (documented in `docs/Operations.md`); the optional admin endpoint that would render it was not built. A future operator dashboard could render it nicely.
- **Multi-region rotation coordination.** Single Cron Trigger, single rotation. If you ever federate Puff across regions with separate workers, the rotation cron should be one of them; the others read keys from KV. Trivially extensible later.
- **KMS / HSM signing.** Plan B keeps the private key in KV. A future hardening step is to move signing into an external service that never reveals the private key to the Worker — out of scope here.
- **Schedule for `usage_rollups` (Phase 9, billing).** That cron is a Worker-side job because it hits an external API (Stripe usage records). Lives in `src/cron.ts` alongside `rotateSigningKey`, not in DB schedules.
