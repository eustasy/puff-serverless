# TODO

Outstanding work, organised into phases. Phases are ordered by dependency and
priority — earlier phases unblock or de-risk later ones. Source markers are cited
as `file:line`; old-PHP-server context links to [`eustasy/puff-server`](https://github.com/eustasy/puff-server).

| Phase | Goal                                 | Gate                                    |
| ----- | ------------------------------------ | --------------------------------------- |
| 1     | Production readiness                 | Required before any production deploy   |
| 2     | Security hardening                   | Should land soon after launch           |
| 3     | Account & password parity            | Core feature parity with the PHP server |
| 4     | Extended capabilities & integrations | Larger, optional-scope work             |
| 5     | Developer experience & polish        | Ongoing                                 |

---

## Phase 1 — Production readiness

Blockers. The app must not be deployed to production until these are done.

### Email delivery — _implemented (Mailtrap)_

Verification and reset links are sent via Mailtrap (`src/mailer.ts`). Remaining
unchecked items are production-deploy operations, not code.

**Configuration & secrets**

- [x] Store the Mailtrap API token as a Cloudflare secret (`MAILTRAP_TOKEN`) on the `puff-serverless` Worker via `wrangler secret put`.
- [x] Set the non-secret email vars for production — `MAILTRAP_SENDER` (`puff@eustasy.org`), `MAILTRAP_SENDER_NAME`, `APP_URL` (`https://puff-serverless.eustasy.org`) — as `vars` in `wrangler.jsonc`.
- [x] `eustasy.org` confirmed as a verified sending domain in Mailtrap — sends from `puff@eustasy.org` are accepted.
- [x] Add the token to `.env` for local development (git-ignored, alongside the Hyperdrive connection string).
- [x] Add `MAILTRAP_SENDER` / `MAILTRAP_SENDER_NAME` env vars (local `.env` uses the `hello@demomailtrap.co` demo sender; pick a verified production domain before launch).
- [x] Dev behaviour decided: live sending API by default; set `MAILTRAP_API_URL` to a sandbox inbox URL to test without delivering real mail.

**Mailer module**

- [x] Integration approach: Mailtrap REST API via native `fetch` — no SDK dependency.
- [x] `src/mailer.ts` — `sendEmail()` plus `sendVerificationEmail()` / `sendPasswordResetEmail()`, returning the standard envelope.
- [x] API failures logged (without the token) and returned as `502` envelopes; 10s timeout via `AbortSignal.timeout`; no automatic retry (resend/re-request flows cover it).

**Templates**

- [x] Verification + password-reset templates (text + HTML) — `src/email-templates.ts`.
- [x] Resend reuses the verification template.

**Call-site wiring**

- [x] Registration verification email — `src/users.ts` (`user_register` now takes `env`).
- [x] Password-reset email — `functions/api/db/password/request.ts`.
- [x] Resend verification email — `functions/api/db/auth/email/resend.ts`.
- [x] Mid-registration send failure: non-fatal — the account is created and the user can resend; a failure is logged, not aborted.
- [x] Both `// SECURITY: remove before production` log sites removed.

**Docs**

- [x] Email env vars added to the `ARCHITECTURE.md` env-vars table.

### Production deployment docs — _done_

- [x] **Document production deployment.** `ARCHITECTURE.md` "for Production Deployment" and a new "Deploying to Production" section now cover the full flow.
  - [x] Hyperdrive / production database setup (`wrangler hyperdrive create`, schema import order).
  - [x] Auth, secrets, vars, `npm run deploy`, and custom-domain steps; production env vars cross-referenced to the Environment Variables table.

> **Phase 1 complete** — the app is no longer blocked from a production deploy.

## Phase 2 — Security hardening

Defence-in-depth work to land shortly after launch.

- [x] **CSRF — `Origin` / `Sec-Fetch-Site` enforcement in middleware.** `SameSite=Lax` (the default) already blocks classic cross-site CSRF, so no CSRF token table is needed. The residual gap is _same-site_ requests from a sibling subdomain (`*.eustasy.org`), which `SameSite` does not stop — relevant for an SSO product. Closed in middleware rather than with per-form tokens.
  - [x] `crossOriginWriteGuard` in `functions/api/db/_middleware.ts` rejects state-changing requests (non-GET/HEAD/OPTIONS) whose `Sec-Fetch-Site` is not `same-origin`, falling back to an `Origin` match when `Sec-Fetch-*` is absent; runs before the DB connection. Returns `403` with an HTML fragment.
  - [x] Audited: every state-changing endpoint is POST. The only state-changing GET is `/api/db/email/verify`, which is token-gated and exempt (GET is a safe method). No endpoint changes needed.
  - [x] `COOKIE_SAMESITE=None` is no longer a CSRF risk — the origin guard does not depend on `SameSite`, so it holds regardless of the cookie policy. The separate warning is therefore moot.
- [x] **Atomic single-use token consumption (`consumeToken`).** The `tokens` table is already the run-once primitive (the typed, expiring, user-scoped successor to PHP's `Runonces`), but consumption is not atomic: `readToken` → check `is_used` → … → `usedToken` is a TOCTOU race — concurrent requests with the same token both pass the check. Affects `2fa/login.ts` (and `usedToken` failure there is swallowed), `password/set.ts`, and `emails.ts#verifyEmailByToken`.
  - [x] Add `consumeToken(dbClient, token_value, expected_type)` to `src/tokens.ts` — a single atomic `UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2 AND is_used = FALSE AND expires_at > NOW() RETURNING …`; `rowCount === 0` collapses used / expired / wrong-type / missing into one "invalid token" outcome.
  - [x] Switch the three consume sites from `readToken` + `usedToken` to `consumeToken`. `password/set.ts` and `emails.ts#verifyEmailByToken` consume directly. `2fa/login.ts` keeps `readToken` as a deliberate non-consuming pre-check — it needs `user_uuid` to load the 2FA secret before verifying, and a wrong TOTP code must not burn the token — then `consumeToken` runs after a valid code; its failure is now fatal, not swallowed. Deliberate tradeoff accepted: a transient failure _after_ the atomic update burns the token (user requests a fresh one).
  - [x] Retained `readToken`, `usedToken`, and `deleteToken` for future non-consume token uses. **`createToken` + `consumeToken` are the recommended pair for any new single-use-token flow** — documented in the `src/tokens.ts` header comment.
- [x] **TOTP code replay protection (RFC 6238 §5.2).** A valid TOTP code is currently accepted repeatedly within its ~30–90s window, in both `2fa/login.ts` and `2fa/setup/verify.ts`. This cannot use the `tokens` table — a TOTP code's key is the user-provided value, not a value we issued.
  - [x] Add `sql/totp_used_codes.sql` — `(user_uuid, totp_code)` primary key with `used_at` for cleanup, FK to users with ON DELETE CASCADE.
  - [x] The replay `INSERT … ON CONFLICT DO NOTHING` lives in `used2fa(dbClient, user_uuid, totp_code)` (`src/2fa.ts`); `rowCount === 0` means replay → `success: false`. Called after a valid code in both login and setup/verify — before `consumeToken` in login so a replay does not burn the pending-login token, and after `enable2fa` in setup so the same call also updates `secret_last_used`.
  - [x] Set `epochTolerance: 30` (±1 time step for clock skew) on both `verify()` calls — previously defaulted to 0.
  - [x] `secret_last_used` stays informational only; it is not the replay guard.
  - [x] Prune `totp_used_codes` rows older than the acceptance window — done by the scheduled cleanup job below.
- [x] **Scheduled cleanup jobs.** This server soft-terminates sessions and marks tokens used, but never reaps them (PHP's hourly cron hard-deleted old sessions).
  - [x] Add a [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) handler — `triggers.crons` in `wrangler.jsonc`, the `scheduled` export wired up by the new `worker.ts` entry, job logic in `src/cron.ts`.
  - [x] Purge `sessions` and `tokens` older than one month (`0 * * * *`). Kept a month first as a lightweight audit trail; sessions are purged only when also defunct, so a still-valid session is never deleted.
  - [x] Purge `totp_used_codes` rows past the acceptance window (`*/5 * * * *`) — runs far more often than the audit purge so a stale row cannot collide with a later, legitimately-different code.
- [ ] **CSP violation reporting.** PHP exposed `api/csp_report.php` and logged breaches.
  - [ ] Add a `report-uri` / `report-to` directive to the CSP in `public/_headers`.
  - [ ] Add a collecting endpoint under `functions/api/`.
- [ ] **Review 2FA QR generation.** Consider a more secure method for generating QR codes — `functions/api/db/auth/2fa/setup/start.ts:132`.
- [ ] **2FA bypass flow.** Replace the password-reset fallback with a dedicated email-based flow to bypass 2FA — `public/2fa.html:56`.

## Phase 3 — Account & password parity

Core feature parity with the PHP server, focused on the account/password lifecycle.

- [ ] **Password-hash upgrade-on-login.** PHP transparently re-hashed outdated methods on successful login (`password.upgrade.php`) plus a batch endpoint. This server only knows `puff_password_SHA-384` with no migration path.
  - [ ] Add hash-method detection / "needs upgrade" check.
  - [ ] Re-hash transparently on successful login.
  - [ ] Provide a batch upgrade path (equivalent to `upgrade_plain_passwords.php`).
- [ ] **Disallow re-using previous passwords** — issue [#22](https://github.com/eustasy/puff-server/issues/22) (Medium). Disabled password hashes are already retained in `secrets`, so reuse can be detected at change/reset time.
- [ ] **Minimum-password-length setting with force-upgrade on login** — issue [#23](https://github.com/eustasy/puff-server/issues/23) (Medium). Length is currently hardcoded to 12 in `src/passwords.ts`; make it configurable and re-check on login.
- [ ] **Prompt when an old (disabled) password is used in a login attempt** — issue [#21](https://github.com/eustasy/puff-server/issues/21) (Low).
- [ ] **Log the user in when registration uses an existing username+password pair** — issue [#20](https://github.com/eustasy/puff-server/issues/20) (Low).
- [ ] **Account disable vs. delete.** PHP distinguished `member.disable` (reversible: `Active=0` + kill all sessions) from `member.destroy`. This server only has soft-delete via `user_active`.
  - [ ] Add a reversible disable that also terminates all sessions.
  - [ ] Add a re-enable flow.

## Phase 4 — Extended capabilities & integrations

Larger, optional-scope features. Each is independent and can be scheduled on demand.

- [ ] **Per-user key/value store.** PHP had a `KeyValues` table and `Puff_Member_Key_*` functions (create/value/update/destroy/like) for arbitrary per-user metadata.
  - [ ] Add a `key_values` table to `sql/`.
  - [ ] Add `src/keyvalues.ts` with the CRUD envelope helpers.
  - [ ] Add endpoints under `functions/api/db/auth/`.
- [ ] **Hooks / extensibility system.** PHP had `_hooks/` + `puff_hook()` for pluggable behaviour (e.g. the `ldap-login` hook adding profile fields).
  - [ ] Design extension points suited to the Workers bundle.
  - [ ] Document the hooks (old-repo issue [#17](https://github.com/eustasy/puff-server/issues/17) notes the PHP hooks were never documented).
- [ ] **LDAP / Active Directory authentication.** PHP `ldap.authenticate.php` bound against an LDAP server, auto-created the member on first login, then issued a session.
  - [ ] **Blocker:** raw LDAP sockets are not available on Workers — pick an LDAP-over-HTTP gateway or directory-provider API first.
  - [ ] Implement the bind + auto-provision-on-first-login flow.
- [ ] **Support multiple databases by default** — old-repo issue [#19](https://github.com/eustasy/puff-server/issues/19) (Priority: High). Currently a single Hyperdrive binding in `wrangler.jsonc`.

## Phase 5 — Developer experience & polish

Non-blocking quality work; pick up alongside related changes.

- [ ] **Add a test suite.** There is currently no automated testing — only `lint` + build (old-repo issue [#16](https://github.com/eustasy/puff-server/issues/16) raised the same gap).
- [ ] **Add a password-strength estimator (Dropbox `zxcvbn`)** — issue [#24](https://github.com/eustasy/puff-server/issues/24) (Low). Augments the live requirements check.
- [ ] **Reuse `readToken` in resend.** `email/resend.ts` imports `readToken` to check whether a token already exists before issuing a new one, but does not yet use it — `functions/api/db/auth/email/resend.ts:1`.
- [ ] **Verify password-requirements assertions.** Confirm the `hasNumber` regex behaves as the commented assertions claim, then remove the stale comment — `src/passwords.ts:308`.

---

## Reference — already at parity or intentionally dropped

No action needed; recorded so the PHP-server comparison is complete.

- **GeoIP** — PHP bundled the MaxMind GeoLite2 database; this server gets `CF-IPCountry` from Cloudflare for free (used in session IP-country checks).
- **HSTS** — PHP had `hsts-attempt.php`; now a static `Strict-Transport-Security` header in `public/_headers`.
- **Sitemap generation, cookie-consent banner, manual-JSON cleanup (issue #14)** — not applicable to a headless auth/SSO service.
