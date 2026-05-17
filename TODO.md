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

- [ ] **Wire up email delivery.** Verification and reset links are currently `console.log`'d server-side as a placeholder. Cloudflare logs are not a safe delivery channel — these leak tokens.
  - [ ] Integrate an email-sending provider/binding.
  - [ ] Replace the registration verification-link log — `src/users.ts:79`.
  - [ ] Replace the password-reset-link log — `functions/api/db/password/request.ts:62`.
  - [ ] Replace the resend-verification-link log — `functions/api/db/auth/email/resend.ts:99`.
  - [ ] Remove both `// SECURITY: remove before production` log sites once delivery works.
- [ ] **Document production deployment.** `ARCHITECTURE.md:43` ("for Production Deployment") is a bare `TODO` stub.
  - [ ] Document Hyperdrive / production database setup.
  - [ ] Document required env vars for production (`SECURE_COOKIE`, `COOKIE_SAMESITE`, `SESSION_MAX_AGE_SECONDS`, etc.).

## Phase 2 — Security hardening

Defence-in-depth work to land shortly after launch.

- [ ] **CSRF protection / run-once tokens.** PHP had a `Runonces` table and `runonce.*` functions for single-use, session-bound tokens. The current HTMX forms have no CSRF protection.
  - [ ] Decide on an approach (per-form run-once token vs. relying on `SameSite` cookies).
  - [ ] Add a `runonce`/CSRF token table + `src` helpers if a token approach is chosen.
  - [ ] Issue and validate tokens across the HTMX forms.
- [ ] **Scheduled cleanup jobs.** This server soft-terminates sessions and marks tokens used, but never reaps them (PHP's hourly cron hard-deleted old sessions).
  - [ ] Add a [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) handler.
  - [ ] Purge expired / inactive sessions.
  - [ ] Purge used / expired tokens.
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
