# TODO

Consolidated list of outstanding work. Each item links back to the inline marker in the source.

## Blockers — must resolve before production

- [ ] **Wire up email delivery.** Verification and reset links are currently `console.log`'d server-side as a placeholder. Cloudflare logs are not a safe delivery channel — these leak tokens.
  - `src/users.ts:79` — registration verification link.
  - `functions/api/db/password/request.ts:62` — password-reset link.
  - `functions/api/db/auth/email/resend.ts:99` — resend verification link.
  - The two `// SECURITY: remove before production` log sites must be removed once delivery exists.
- [ ] **Document production deployment.** `ARCHITECTURE.md:43` ("for Production Deployment") is a bare `TODO` stub.

## Security

- [ ] **2FA setup QR generation.** Consider a more secure method for generating QR codes — `functions/api/db/auth/2fa/setup/start.ts:132`.

## Features

- [ ] **2FA bypass flow.** Replace the password-reset fallback with a dedicated email-based flow to bypass 2FA — `public/2fa.html:56`.

## Code quality

- [ ] **Reuse `readToken` in resend.** `email/resend.ts` imports `readToken` to check whether a token already exists before issuing a new one, but does not yet use it — `functions/api/db/auth/email/resend.ts:1`.
- [ ] **Verify password-requirements assertions.** Confirm the `hasNumber` regex behaves as the commented assertions claim, then remove the stale comment — `src/passwords.ts:308`.

## Feature parity with the old PHP server (`puff-server`)

Gaps found by comparing this rewrite against the legacy PHP repo
([`eustasy/puff-server`](https://github.com/eustasy/puff-server)) and its open issues.

### Capabilities the PHP server had that this one lacks

- [ ] **Per-user key/value store.** PHP had a `KeyValues` table and `Puff_Member_Key_*` functions (create/value/update/destroy/like) for arbitrary per-user metadata. No equivalent here — would need a `key_values` table and `src/keyvalues.ts`.
- [ ] **LDAP / Active Directory authentication.** PHP `ldap.authenticate.php` bound against an LDAP server, auto-created the member on first login, then issued a session. Not ported. (Note: raw LDAP sockets are not available on Workers — would need an LDAP-over-HTTP gateway or a directory provider's API.)
- [ ] **Password-hash upgrade-on-login.** PHP detected outdated hash methods (`PLAIN`, `sha512`, low-cost BCRYPT) via `password.upgrade.php` and transparently re-hashed on successful login, plus a batch `upgrade_plain_passwords.php` endpoint. This server only knows `puff_password_SHA-384` with no migration path — needed before any future algorithm change.
- [ ] **Scheduled cleanup jobs.** PHP had `_cron/` (minute/hourly/daily/weekly/monthly); the hourly job hard-deleted inactive/old sessions. This server soft-terminates sessions and marks tokens used but never reaps them. Add a [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) to purge expired sessions and used/expired tokens.
- [ ] **Run-once / CSRF tokens.** PHP had a `Runonces` table and `runonce.*` functions for single-use, session-bound tokens. No CSRF protection exists on the current HTMX forms — worth assessing alongside `SameSite` cookie settings.
- [ ] **CSP violation reporting.** PHP exposed `api/csp_report.php` and logged breaches. The CSP in `public/_headers` has no `report-uri` / `report-to` directive or collecting endpoint.
- [ ] **Hooks / extensibility system.** PHP had `_hooks/` + `puff_hook()` for pluggable behaviour (e.g. the `ldap-login` hook adding profile fields). No extension points exist here. (Lower priority; old-repo issue #17 also notes the hooks were never documented.)
- [ ] **Account disable vs. delete.** PHP distinguished `member.disable` (reversible: `Active=0` + kill all sessions) from `member.destroy`. This server only has soft-delete via `user_active`; there is no admin-facing disable/re-enable flow.

### Enhancement requests carried over from `puff-server` open issues

These were never built in the PHP server either, but are still desired:

- [ ] **Support multiple databases by default.** — old-repo issue [#19](https://github.com/eustasy/puff-server/issues/19) (Priority: High). Currently a single Hyperdrive binding in `wrangler.jsonc`.
- [ ] **Log the user in when registration uses an existing username+password pair.** — issue [#20](https://github.com/eustasy/puff-server/issues/20) (Low).
- [ ] **Prompt the user when an old (disabled) password is used in a login attempt.** — issue [#21](https://github.com/eustasy/puff-server/issues/21) (Low).
- [ ] **Disallow re-using previous passwords.** — issue [#22](https://github.com/eustasy/puff-server/issues/22) (Medium). Disabled password hashes are already retained in `secrets`, so reuse can be detected.
- [ ] **Minimum-password-length setting with force-upgrade on login.** — issue [#23](https://github.com/eustasy/puff-server/issues/23) (Medium). Length is currently hardcoded to 12 in `src/passwords.ts`.
- [ ] **Add a password-strength estimator (Dropbox `zxcvbn`).** — issue [#24](https://github.com/eustasy/puff-server/issues/24) (Low). Would augment the live requirements check.

### Already at parity or intentionally dropped

No action needed — recorded so the comparison is complete:

- **GeoIP** — PHP bundled the MaxMind GeoLite2 database; this server gets `CF-IPCountry` from Cloudflare for free (used in session IP-country checks).
- **HSTS** — PHP had `hsts-attempt.php`; now a static `Strict-Transport-Security` header in `public/_headers`.
- **Sitemap generation, cookie-consent banner, manual-JSON cleanup (issue #14)** — not applicable to a headless auth/SSO service.
