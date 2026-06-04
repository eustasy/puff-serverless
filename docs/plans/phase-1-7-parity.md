# Puff-PHP Parity Plan

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

* [x] Store the Mailtrap API token as a Cloudflare secret (`MAILTRAP_TOKEN`) on the `puff-serverless` Worker via `wrangler secret put`.
* [x] Set the non-secret email vars for production — `MAILTRAP_SENDER` (`puff@eustasy.org`), `MAILTRAP_SENDER_NAME`, `APP_URL` (`https://puff-serverless.eustasy.org`) — as `vars` in `wrangler.jsonc`.
* [x] `eustasy.org` confirmed as a verified sending domain in Mailtrap — sends from `puff@eustasy.org` are accepted.
* [x] Add the token to `.env` for local development (git-ignored, alongside the Hyperdrive connection string).
* [x] Add `MAILTRAP_SENDER` / `MAILTRAP_SENDER_NAME` env vars (local `.env` uses the `hello@demomailtrap.co` demo sender; pick a verified production domain before launch).
* [x] Dev behaviour decided: live sending API by default; set `MAILTRAP_API_URL` to a sandbox inbox URL to test without delivering real mail.

**Mailer module**

* [x] Integration approach: Mailtrap REST API via native `fetch` — no SDK dependency.
* [x] `src/mailer.ts` — `sendEmail()` plus `sendVerificationEmail()` / `sendPasswordResetEmail()`, returning the standard envelope.
* [x] API failures logged (without the token) and returned as `502` envelopes; 10s timeout via `AbortSignal.timeout`; no automatic retry (resend/re-request flows cover it).

**Templates**

* [x] Verification + password-reset templates (text + HTML) — `src/email-templates.ts`.
* [x] Resend reuses the verification template.

**Call-site wiring**

* [x] Registration verification email — `src/users.ts` (`user_register` now takes `env`).
* [x] Password-reset email — `functions/api/db/password/request.ts`.
* [x] Resend verification email — `functions/api/db/auth/email/resend.ts`.
* [x] Mid-registration send failure: non-fatal — the account is created and the user can resend; a failure is logged, not aborted.
* [x] Both `// SECURITY: remove before production` log sites removed.

**Docs**

* [x] Email env vars added to the `docs/Architecture.md` env-vars table.

### Production deployment docs — _done_

* [x] **Document production deployment.** `docs/Deployment.md` covers the full flow end-to-end with copy-paste commands; `docs/Architecture.md` is the env-vars reference.
  * [x] Hyperdrive / production database setup (`wrangler hyperdrive create`, schema import order).
  * [x] Auth, secrets, vars, `npm run deploy`, and custom-domain steps; production env vars cross-referenced to the Environment Variables table.

> **Phase 1 complete** — the app is no longer blocked from a production deploy.

## Phase 2 — Security hardening

Defence-in-depth work to land shortly after launch.

* [x] **CSRF — `Origin` / `Sec-Fetch-Site` enforcement in middleware.** `SameSite=Lax` (the default) already blocks classic cross-site CSRF, so no CSRF token table is needed. The residual gap is _same-site_ requests from a sibling subdomain (`*.eustasy.org`), which `SameSite` does not stop — relevant for an SSO product. Closed in middleware rather than with per-form tokens.
  * [x] `crossOriginWriteGuard` in `functions/api/db/_middleware.ts` rejects state-changing requests (non-GET/HEAD/OPTIONS) whose `Sec-Fetch-Site` is not `same-origin`, falling back to an `Origin` match when `Sec-Fetch-*` is absent; runs before the DB connection. Returns `403` with an HTML fragment.
  * [x] Audited: every state-changing endpoint is POST. The only state-changing GET is `/api/db/email/verify`, which is token-gated and exempt (GET is a safe method). No endpoint changes needed.
  * [x] `COOKIE_SAMESITE=None` is no longer a CSRF risk — the origin guard does not depend on `SameSite`, so it holds regardless of the cookie policy. The separate warning is therefore moot.
* [x] **Atomic single-use token consumption (`consumeToken`).** The `tokens` table is already the run-once primitive (the typed, expiring, user-scoped successor to PHP's `Runonces`), but consumption is not atomic: `readToken` → check `is_used` → … → `usedToken` is a TOCTOU race — concurrent requests with the same token both pass the check. Affects `2fa/login.ts` (and `usedToken` failure there is swallowed), `password/set.ts`, and `emails.ts#verifyEmailByToken`.
  * [x] Add `consumeToken(dbClient, token_value, expected_type)` to `src/tokens.ts` — a single atomic `UPDATE tokens SET is_used = TRUE WHERE token_value = $1 AND token_type = $2 AND is_used = FALSE AND expires_at > NOW() RETURNING …`; `rowCount === 0` collapses used / expired / wrong-type / missing into one "invalid token" outcome.
  * [x] Switch the three consume sites from `readToken` + `usedToken` to `consumeToken`. `password/set.ts` and `emails.ts#verifyEmailByToken` consume directly. `2fa/login.ts` keeps `readToken` as a deliberate non-consuming pre-check — it needs `user_uuid` to load the 2FA secret before verifying, and a wrong TOTP code must not burn the token — then `consumeToken` runs after a valid code; its failure is now fatal, not swallowed. Deliberate tradeoff accepted: a transient failure _after_ the atomic update burns the token (user requests a fresh one).
  * [x] Retained `readToken`, `usedToken`, and `deleteToken` for future non-consume token uses. **`createToken` + `consumeToken` are the recommended pair for any new single-use-token flow** — documented in the `src/tokens.ts` header comment.
* [x] **TOTP code replay protection (RFC 6238 §5.2).** A valid TOTP code is currently accepted repeatedly within its ~30–90s window, in both `2fa/login.ts` and `2fa/setup/verify.ts`. This cannot use the `tokens` table — a TOTP code's key is the user-provided value, not a value we issued.
  * [x] Add `sql/totp_used_codes.sql` — `(user_uuid, totp_code)` primary key with `used_at` for cleanup, FK to users with ON DELETE CASCADE.
  * [x] The replay `INSERT … ON CONFLICT DO NOTHING` lives in `used2fa(dbClient, user_uuid, totp_code)` (`src/2fa.ts`); `rowCount === 0` means replay → `success: false`. Called after a valid code in both login and setup/verify — before `consumeToken` in login so a replay does not burn the pending-login token, and after `enable2fa` in setup so the same call also updates `secret_last_used`.
  * [x] Set `epochTolerance: 30` (±1 time step for clock skew) on both `verify()` calls — previously defaulted to 0.
  * [x] `secret_last_used` stays informational only; it is not the replay guard.
  * [x] Prune `totp_used_codes` rows older than the acceptance window — done by the scheduled cleanup job below.
* [x] **Scheduled cleanup jobs.** This server soft-terminates sessions and marks tokens used, but never reaps them (PHP's hourly cron hard-deleted old sessions).
  * [x] Add a [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) handler — `triggers.crons` in `wrangler.jsonc`, the `scheduled` export wired up by the new `worker.ts` entry, job logic in `src/cron.ts`.
  * [x] Purge `sessions` and `tokens` older than one month (`0 * * * *`). Kept a month first as a lightweight audit trail; sessions are purged only when also defunct, so a still-valid session is never deleted.
  * [x] Purge `totp_used_codes` rows past the acceptance window (`*/5 * * * *`) — runs far more often than the audit purge so a stale row cannot collide with a later, legitimately-different code.
* [x] **CSP violation reporting.** PHP exposed `api/csp_report.php` and logged breaches.
  * [x] Added `report-uri /api/csp-report` and `report-to csp-endpoint` to both CSP lines in `public/_headers`, plus a `Reporting-Endpoints` header naming `csp-endpoint` for the modern Reporting API.
  * [x] Added `functions/api/csp-report.ts` — a DB-free, unauthenticated collector that parses both the legacy `{ "csp-report": … }` body and the modern `application/reports+json` array, logs each violation (`console.warn`, capped per request), and returns `204`.
* [x] **Review 2FA QR generation.** The QR code was generated by sending the `otpauth://` URI — which embeds the TOTP secret — to the third-party `api.qrserver.com`, leaking every user's 2FA seed. Now rendered in the Worker as an inline `<svg>` via `uqr` (zero-dependency, Workers-native); the secret never leaves the origin. Inline SVG is page markup, so it is also unaffected by the page's `default-src https:` CSP (a `data:` URI would not be).
* [x] **2FA bypass flow.** Replaced the "do a password reset" fallback (which never actually bypassed 2FA) with a dedicated email-based flow.
  * [x] `POST /api/db/2fa/bypass/request` — identifies the user from the `totp_verification_token` cookie (validated via a non-consuming `readToken`, so a retry never burns it), emails a one-time link to the first _verified_ address on the account, and returns a generic acknowledgement that never reveals account/email state.
  * [x] `GET /api/db/2fa/bypass/verify?token=…` — the emailed link; `consumeToken` atomically spends the `totp_bypass` token, `createSession` issues the session, and the response sets the session cookie, clears the pending cookie, and `Location`-redirects to `/account`. Token-gated GET, exempt from the cross-origin guard like `/api/db/email/verify`.
  * [x] `createBypassToken` (`src/tokens.ts`, type `totp_bypass`, 1-hour expiry), `twoFactorBypassEmail` template, `sendTwoFactorBypassEmail` mailer helper.
  * [x] `public/2fa.html` — the TODO comment is replaced with a `<details>` "Lost access to your authenticator?" section that POSTs to the request endpoint. The two factors are preserved: the password (already proven to reach the 2FA step) plus control of the verified inbox.

> **Phase 2 complete.**

## Phase 3 — Account & password parity

Core feature parity with the PHP server, focused on the account/password lifecycle.

* [x] **Password-hash upgrade-on-login.** PHP transparently re-hashed outdated methods on successful login (`password.upgrade.php`) plus a batch endpoint. This server only knows `puff_password_SHA-384` with no migration path.
  * [x] Add hash-method detection / "needs upgrade" check. (`PREFERRED_PASSWORD_ALGO` + `passwordNeedsUpgrade()` in `src/utilities/hashing.ts`; surfaced as `needs_upgrade` on `password_verify`.)
  * [x] Re-hash transparently on successful login. (`user_login` calls `updatePassword` when `needs_upgrade` is set — best-effort, never blocks the login.)
* [x] **Disallow re-using previous passwords** — issue [#22](https://github.com/eustasy/puff-server/issues/22) (Medium). Disabled password hashes are already retained in `secrets`, so reuse can be detected at change/reset time. (`passwordReused()` in `src/passwords.ts` re-hashes the candidate with every stored row's salt+algo; enforced in `password/change.ts` and `password/set.ts`. The reset flow runs the check before consuming the token, so a reused password doesn't burn the reset link.)
* [x] **Minimum-password-length setting with force-upgrade on login** — issue [#23](https://github.com/eustasy/puff-server/issues/23) (Medium). Length is currently hardcoded to 12 in `src/passwords.ts`; make it configurable and re-check on login. (`MIN_PASSWORD_LENGTH` env var via `getMinPasswordLength()`; `password_requirements` parameterised. `user_login` re-checks the plaintext length and, when too short, returns `password_upgrade_required` — `user/login.ts` issues a `password_upgrade` token and redirects to the new `/password-upgrade` page, handled by `functions/api/db/password/upgrade.ts`, which completes the login or hands off to 2FA.)
* [x] **Prompt when an old (disabled) password is used in a login attempt** — issue [#21](https://github.com/eustasy/puff-server/issues/21) (Low). (`user_login` runs `passwordReused` on a failed verify; since the active password already failed, any hit is a previous password — the user gets a "you previously used this password" prompt instead of the generic failure.)
* [x] **Log the user in when registration uses an existing username+password pair** — issue [#20](https://github.com/eustasy/puff-server/issues/20) (Low). (When registration hits an existing email, `register.ts` runs `user_login`; a matching password logs the user in — session, 2FA, or password-upgrade — via the shared `loginOutcomeResponse` helper. A wrong password keeps the generic 409.)
* [x] **Account disable vs. delete.** PHP distinguished `member.disable` (reversible: `Active=0` + kill all sessions) from `member.destroy`. This server only has soft-delete via `user_active`.
  * [x] Add a reversible disable that also terminates all sessions. (`disableUser` in `src/users.ts` — transactional `user_active = FALSE` + `terminateAllSessions`. `user_login` now rejects disabled accounts after a proven password.)
  * [x] Add a re-enable flow. (`enableUser` in `src/users.ts`.)
  * [x] The old `deleteUser` (which only soft-deleted) is now a real permanent hard delete — a single `DELETE FROM users`, with all child rows removed by `ON DELETE CASCADE` foreign keys (`sql/*.sql` updated; existing databases need the cascade `ALTER`).
* [x] **WebAuthn / Passkeys.** Passkey login does not trigger the 2FA gate — the passkey itself satisfies both factors.
  * [x] `sql/passkeys.sql` — new table with `credential_id UNIQUE` index for O(1) lookup during authentication; FK to `users` with `ON DELETE CASCADE`.
  * [x] `src/passkeys.ts` — domain module: `listPasskeys`, `getPasskeyByCredentialId`, `savePasskey`, `updatePasskeyCounter`, `deletePasskey`, `getUserByUsername`, `getRpConfig`. RP ID defaults to hostname of `APP_URL`; RP name defaults to `APP_NAME`.
  * [x] `createWebAuthnToken` added to `src/tokens.ts` — inserts a caller-supplied challenge (base64url bytes) as `token_value`, so the challenge and the look-up key are the same string. Token types: `webauthn_registration_challenge`, `webauthn_authentication_challenge` (5-minute TTL each).
  * [x] Registration endpoints under `functions/api/db/auth/passkeys/` (authenticated): `register/start.ts` generates options + challenge token + cookie; `register/complete.ts` verifies via `@simplewebauthn/server`, saves credential; `list.ts` returns HTML fragment; `delete.ts` removes (user-ownership guard).
  * [x] Authentication endpoints under `functions/api/db/passkeys/authenticate/` (unauthenticated): `start.ts` generates auth options (enumeration-safe: always returns valid JSON even if username absent); `complete.ts` consumes token atomically, verifies response, updates counter, grants session **directly** — no `has2fa` check.
  * [x] `public/assets/webauthn.js` — minimal ES module using raw `navigator.credentials` API; no bundler or third-party browser library needed. Base64url encode/decode helpers included.
  * [x] `public/account.html` — Passkeys section (list + register button) with `hx-trigger="passkeysChanged from:body"` pattern matching the 2FA section.
  * [x] `public/login.html` — passkey login form (username input + "Use Passkey" button) below the password form.
  * [x] New env vars: `WEBAUTHN_RP_ID` (default: hostname from `APP_URL`), `WEBAUTHN_RP_NAME` (default: `APP_NAME`).
  * [x] `@simplewebauthn/server` v13 added (uses Web Crypto API — Workers-native; no Node crypto dependency).

## Phase 4 — Extended capabilities & integrations

Larger, optional-scope features. Each is independent and can be scheduled on demand.

* [x] **Per-user key/value store.** PHP had a `KeyValues` table and `Puff_Member_Key_*` functions (create/value/update/destroy/like) for arbitrary per-user metadata. Now superseded by the generalised KV store — see `Phase 6 → Key/value scoping`. The user-scoped surface (`user_key_values`, `src/user-keyvalues.ts`, the `functions/api/db/auth/keyvalues/` endpoints, the account-page "Stored Data" section) is unchanged from the user's point of view but is now one subject within a five-subject system.

## Phase 5 — Developer experience & polish

Non-blocking quality work; pick up alongside related changes.

* [x] **Consistent function names.** Renamed across all `src/` modules and call sites: snake_case → camelCase (`password_verify` → `verifyPassword`, `password_requirements` → `passwordRequirements`, `password_requirements_html` → `passwordRequirementsHtml`, `user_register` → `registerUser`, `user_login` → `loginUser`); verb/action alignment (`listSessionsForUser` → `readSessions`, `terminateSpecificSession` → `terminateSession`, `getMinPasswordLength` → `minPasswordLength`, `passwordReused` → `isPasswordReused`); and disambiguated the old `loginUser` (timestamp-touch helper) → `updateLastLogin` to free the name for the main login function. Skipped: `usedToken`, `has2fa`, `existsEmail`, `verifyEmailByToken` — left as-is by design.
* [x] **Consistent function descriptions.** Added JSDoc to all undocumented `src/` exports (`2fa.ts` × 6, `email-templates.ts` × 3); corrected four stale `@returns {Promise<boolean>}` in `passwords.ts` to describe the actual Envelope shapes; disambiguated the identical descriptions on `passwordRequirements` / `passwordRequirementsHtml`; improved vague "An object indicating success or failure" returns in `emails.ts`; removed redundant `(Optional)` text from bracketed params in `sessions.ts`.
* [x] **Do not log sensitive data.** Removed email address (PII) from password-reset "not found" log in `functions/api/db/password/request.ts`; removed `session_id` (auth credential) from the `terminateSession` error log in `src/sessions.ts`. All other console calls log only error objects, UUIDs, or internal status strings.
* [x] **Add a password-strength estimator (Dropbox `zxcvbn`) with configurable policy.** `zxcvbn` npm package added. `PasswordConfig` interface and `passwordConfig(env)` added to `src/passwords.ts`; all five requirement endpoints updated to pass the full config. New env vars: `REQUIRE_NUMBER`, `REQUIRE_CAPITAL`, `REQUIRE_SPECIAL_CHAR`, `REQUIRE_NOT_COMPROMISED`, `SHOW_ZXCVBN`, `REQUIRE_ZXCVBN`. When `REQUIRE_ZXCVBN` is set, score ≥ 3 is the hard gate and the individual character-class rules become suggestions; `MIN_PASSWORD_LENGTH` always applies. `REQUIRE_NOT_COMPROMISED` makes the HIBP check a hard gate (fail-open on network error). `passwordRequirements` is now async to support the HIBP network call.
* [x] **Reuse existing token in resend.** `email/resend.ts` now queries for an unexpired, unused `email_verification` token before calling `createEmailToken` — repeated resend clicks reuse the same token rather than accumulating new ones. (`readToken` was removed; it only looks up by `token_value`, which the resend flow does not have.)
* [x] **Verify password-requirements assertions.** Both regexes confirmed correct; stale TODO comment removed. `hasSpecial` (`/[^a-zA-Z\d]/`) matches spaces, which is intentional — a space counts as a special character.
* [x] **Sitemap generation.** `functions/sitemap.xml.ts` serves `/sitemap.xml` dynamically from `context.env.APP_URL` — covers `/`, `/login`, `/register`, `/reset/request`; excludes authenticated and token-gated pages. `public/robots.txt` added pointing to the sitemap.
* [x] **.html auth handling.** `functions/_middleware.ts` (root middleware) guards static HTML pages in two groups. Group A redirects to `/login` (302) when the required cookie is absent — `/account` + `/logout` need `session_token`; `/2fa` + `/password-upgrade` need their mid-login flow-token cookie (`totp_verification_token` / `password_upgrade_token`) — presence-only, the API layer does the real token check. Group B redirects logged-in users away from `/login` + `/register` to `/account`; this one is DB-verified (opens a short-lived `pg` connection only when a `session_token` cookie is actually present, fails open) so a stale/terminated session cookie cannot trap a user on `/login`. Requires `assets.run_worker_first` listing all six paths in `wrangler.jsonc` — static assets are served before the Worker by default, so the middleware would otherwise never run — plus `assets.binding: "ASSETS"` so `context.next()` can fall through to `env.ASSETS.fetch()`.
* [x] Transactions are always run in serializable isolation level
* [x] **Add a test suite.** [Vitest](https://vitest.dev) unit tests in `test/`, one `*.test.ts` per `src/` module (221 tests). Run with `npm test`. Tests run in plain Node with no real database: a fake `pg` client (`test/helpers/fake-db.ts`) scripts query responses by SQL match, and `test/helpers/fake-env.ts` builds a minimal `Env`. `test/**` is in the `tsconfig` `include` so `npm run typecheck` covers tests. (Old-repo issue [#16](https://github.com/eustasy/puff-server/issues/16) raised the same gap.)

## Phase 6 — Organisations

Multi-tenancy: group users into **organisations**, subdivide them into **teams**,
and let a user hold several **roles** independently in any organisation or team
they belong to. Users stay global — one account, many memberships — which is the
right model for an SSO product. Billing (Phase 8) will attach to the organisation.

**Data model.** Role assignment is the primitive: each (user, scope, role) is one
row, and a user may hold any combination. "Membership" is _derived_ from those
rows — a **full member** holds an organisation-level membership role; a **guest**
holds only team-level or individually-granted roles in that org. Org owners can
grant a role to any user, member or not, so role grants are never gated on prior
membership. Polymorphic "scope" columns are avoided — they would break the FK +
`ON DELETE CASCADE` integrity the schema relies on — so organisation- and
team-scoped grants are separate tables.

**Roles.** Organisation and team RBAC is **code-defined and fixed**: the role
set and the role → permission mapping both live in `src/permissions.ts` (the
`can()` matrix), not the database. Only role _assignments_ — which user holds
which role — are stored in tables. Organisations are not given customisable
roles; they use the fixed puff role set. The data-driven, customisable
permission model is exclusively for linked apps (Phase 7).

### Schema (`sql/`)

* [x] `sql/organisations.sql` — `org_uuid` PK, `org_name`, `org_active` (reversible-disable flag, mirroring `user_active`), `org_created_at`, `org_created_by` (FK → `users`, `ON DELETE SET NULL`). Identified by UUID — no slug, names need not be unique.
* [x] `sql/teams.sql` — `team_uuid` PK, `org_uuid` (FK → `organisations`, `ON DELETE CASCADE`), `team_name`, `team_created_at`, plus `idx_teams_org_uuid` for the FK and `listTeams` lookups.
* [x] `sql/organisation_members.sql` — organisation-scoped role grants. Composite PK `(org_uuid, user_uuid, role)`; FKs to `organisations` and `users`, both `ON DELETE CASCADE`; `added_at`, `added_by` (FK → `users`, `ON DELETE SET NULL`). `idx_organisation_members_user_uuid` serves the `user_uuid` FK and "orgs for a user" lookups.
* [x] `sql/team_members.sql` — team-scoped role grants. Composite PK `(team_uuid, user_uuid, role)`; FKs to `teams` and `users`, both `ON DELETE CASCADE`; `added_at`, `added_by`. `idx_team_members_user_uuid` serves the `user_uuid` FK and guest detection (team grants with no `organisation_members` row). There is deliberately no "team membership requires org membership" constraint.
* [x] The `role` columns are plain text, validated in `src/` against the fixed `src/permissions.ts` role set. They stay plain text — Puff's org/team roles are code-defined, not a database `roles` table.
* [x] Schema import order extended to `users` → `organisations` → `teams` → `organisation_members` / `team_members`; ordering note updated in `CLAUDE.md`, `docs/Deployment.md`, and `database.instructions.md`.

### Roles & authorisation

* [x] Role set as a `src/permissions.ts` constant — organisation roles `owner` / `admin` / `member` / `billing`, team roles `lead` / `member` (`ORG_ROLES` / `TEAM_ROLES`). A user may hold any combination. `OWNER_ROLE` / `DEFAULT_ORG_ROLE` / `DEFAULT_TEAM_ROLE` exported for the domain modules; `isOrgRole` / `isTeamRole` type guards validate role names from request input.
* [x] `can(roles, action)` capability helper — resolves a role set to a boolean for a typed action (`OrgAction` / `TeamAction`, e.g. `org:update`, `org:teams:create`, `team:members:add`). The action prefix selects the scope. Endpoints check the capability, never a raw role string. The role → permission matrix is code-defined in `src/permissions.ts` and stays that way — org/team roles are not customisable; the data-driven permission model (Phase 7) is apps-only.
* [x] `owner` is privileged: an organisation must always retain at least one `owner` — enforced by `removeOrgMember` / `setOrgMemberRoles` in `src/memberships.ts`.
* [x] Owners can grant any role to any user: `addOrgMember` and the team equivalents accept a `user_uuid` with no prior relationship to the org — this is how an external user becomes a guest or a member.

### Domain modules (`src/`)

Each new module follows the existing conventions: `dbClient` first, structured
envelopes, no HTTP. Multi-step writes use `runInTransaction`.

* [x] `src/organisations.ts` — `createOrganisation` (transactional: insert org + add the creator as `owner`), `readOrganisation`, `updateOrganisation`, `disableOrganisation` / `enableOrganisation` (reversible, mirroring `disableUser`), `deleteOrganisation` (hard delete; cascade reaps teams + memberships), `listOrganisationsForUser`.
* [x] `src/teams.ts` — `createTeam`, `readTeam`, `updateTeam`, `deleteTeam`, `listTeams` (for an org).
* [x] `src/memberships.ts` — `addOrgMember` / `removeOrgMember` / `setOrgMemberRoles`, `listOrgMembers`, the team equivalents, and per-scope role lookups `getOrgRoles` / `getTeamRoles` (the planned single `getUserRoles` split into two scope-explicit functions; the `[org_uuid]` middleware composes them).

### Endpoints & routing (`functions/api/db/auth/`)

* [x] `organisations/` — `list` (GET, the caller's orgs with roles) and `create` (POST; the creator becomes `owner`).
* [x] `organisations/[org_uuid]/_middleware.ts` — resolves the caller's organisation roles into `context.data.orgRoles` (Pages Functions `[org_uuid]` segment). It does not 403 itself: each endpoint authorises with `can(...)`, which a caller holding no roles fails — so guests still reach the nested team routes, where the team `_middleware.ts` authorises them.
* [x] `organisations/[org_uuid]/` — `read` / `update` / `disable` / `enable` / `delete`; `members/` (`list` / `add` / `remove` / `roles`); `teams/` (`list` / `create`). `members/add` adds an _existing_ user by username/email; adding someone without an account is the separate "Member invitations" flow below.
* [x] `organisations/[org_uuid]/teams/[team_uuid]/` — `read` / `update` / `delete` and `members/` (`list` / `add` / `remove` / `roles`). The team `_middleware.ts` confirms the team belongs to `[org_uuid]` (404 otherwise) and resolves `context.data.teamRoles`; team endpoints authorise on `can(teamRoles, …) || can(orgRoles, "org:teams:manage")` so org admins manage any team.
* [x] All responses are HTML fragments (`result-positive` / `result-negative`) via a new `src/utilities/responses.ts` helper (`htmlResponse` / `resultPositive` / `resultNegative` / `methodNotAllowed`).

### Member invitations

* [x] Invitations work whether or not the invitee has an account, via a dedicated `sql/organisation_invitations.sql` table — the generic `tokens` table has no columns for the organisation and role set an invitation must carry, and a real FK to `organisations` (`ON DELETE CASCADE`) keeps pending invitations consistent. `src/invitations.ts` — `createInvitation`, `readInvitation`, `acceptInvitation` (atomic single-`UPDATE` consume, like `consumeToken`), `listInvitations`, `revokeInvitation`.
* [x] `POST …/members/invite` issues the invitation and emails a link (`organisationInvitationEmail` template + `sendOrganisationInvitationEmail` mailer helper); `…/invitations/list` + `…/invitations/revoke` manage pending ones. The link opens `/invite?token=…`: `db/organisations/invitation/view` previews it unauthenticated, `auth/organisations/invitation/accept` consumes it for the signed-in user (a new invitee registers first, then accepts with the same token — a frontend navigation, no backend change to registration). Possession of the token is the capability; the accepting account need not own the invited address.

### Lifecycle & integrity

* [x] Last-owner guard: `removeOrgMember` / `setOrgMemberRoles` reject any change that would leave an organisation with no `owner` (transactional owner-count check in `src/memberships.ts`).
* [x] `deleteUser` interaction: a transactional sole-owner pre-check in `src/users.ts` refuses (409) to delete a user who is the only `owner` of an organisation, naming those organisations — the caller transfers ownership or deletes them first. (`org_created_by` / `added_by` / `invited_by` are all `ON DELETE SET NULL`, so deleting a user never cascades into organisations; only the `organisation_members` owner row could orphan one.)
* [x] `disableUser` keeps organisation and team memberships intact — a disabled user cannot log in (`loginUser` rejects on `user_active`), so cannot exercise them, and re-enabling restores access. Noted in the `disableUser` doc comment.

### Frontend (`public/`)

* [x] `public/account.html` — an "Organisations" section: a create-organisation form and a list (`hx-trigger="load, organisationsChanged from:body"`, matching the 2FA / Passkeys sections), plus an `#organisation-detail` panel an organisation's "Manage" button loads into.
* [x] Organisation management has a dedicated page — `functions/organisations/[org_uuid].ts` renders `/organisations/:org_uuid` (a Pages Function, parameterised by the path UUID; a presence-only `session_token` check bounces to `/login`). The page is a shell that HTMX-loads the `[org_uuid]/read` fragment — the management panel: edit, disable/enable/delete, and the teams / members / invitations sub-sections with their forms (team management nests within it). The account page's Organisations list links each row to its org page. All fragments carry the `[org_uuid]` / `[team_uuid]` in their `hx-*` URLs and gate every control server-side with `can(...)`; member-list fragments include a collapsible role editor and remove buttons. `functions/invite.ts` likewise renders the `/invite?token=…` accept page (a Pages Function — it needs the query-string token, the `sitemap.xml.ts` precedent).

### Tests & docs

* [x] A `test/*.test.ts` file per new `src/` module (`organisations`, `teams`, `memberships`, `permissions`), following the `FakeDb` pattern.
* [x] `docs/Hierarchy.md` covers the Organisations / Teams / Memberships data model; the `database.instructions.md` table list has per-table column reference for the five new tables. Import order is in `CLAUDE.md` and `docs/Deployment.md`.

### Key/value scoping

* [x] Generalised KV from per-user to per-subject (user / team / organisation / org-role / team-role), each with a first-class **owner** dimension (`owner_user_uuid` + `owner_org_uuid` nullable FKs, CHECK exactly-one-set, both CASCADE; primary key includes a computed STORED `owner_id`). One `sql/*_key_values.sql` table per subject; one `src/*-keyvalues.ts` module each, sharing `src/utilities/keyvalues-shared.ts` (constants, validation, the SERIALIZABLE upsert flow). The `apps` subject + `owner_app_uuid` column are deferred to Phase 7 alongside `sql/apps.sql`.
* [x] **Inheritance resolver** — `src/keyvalues-resolver.ts`'s `resolveKeyValue` walks user → team-role → org-role → team → org (most-specific first), all filtered by the `owner` namespace, returning `{ values: string[], source }`. The role tier merges + de-duplicates across the user's roles in that scope (decided 2026-05-19: roles do not block each other at the KV layer; granular perms are stored as separate keys, not as competing values).
* [x] **Endpoints** — self-owned user data stays at `functions/api/db/auth/keyvalues/{list,set,remove}.ts`. Org-owned data has five new trees under `functions/api/db/auth/organisations/[org_uuid]/`: `keyvalues/` (org subject), `users/[user_uuid]/keyvalues/` (user subject), `roles/[role]/keyvalues/` (org-role subject), `teams/[team_uuid]/keyvalues/` (team subject), `teams/[team_uuid]/roles/[role]/keyvalues/` (team-role subject). Gated by `can(...)` with new `org:keyvalues:read/write` and `team:keyvalues:read/write` actions in `src/permissions.ts`.

### Open decisions

* [x] **How "guest" is surfaced.** Decided 2026-05-20: explicit, not derived. Added `guest` to `ORG_ROLES` with a single org capability (`org:view`, enough to render the org page they belong to); their actual team-level access flows from `team_members` rows as usual. The role is a marker — it lets us list guests alongside members and avoids the "team_members without organisation_members" derivation. `addOrgMember` / invitations accept the role automatically via `isOrgRole`; the role-tier KV resolver picks them up as a normal org-role.

## Phase 7 — OAuth identity provider & federated login

Two directions, plus the permission system that links them:

* **Puff as identity provider** — an arbitrary number of apps log their users in
  _with_ Puff-Serverless; Puff issues the tokens (OAuth 2.1 / OpenID Connect).
* **Puff as OAuth client** — users log in to Puff-Serverless itself _with_
  GitHub, Microsoft, or Google, federating those identities onto a Puff account.
* **Custom roles** (moved here from Phase 6) become the access model Puff exposes
  to the apps it logs users into.

OAuth-based external login is preferred over LDAP, which is kept below as a
separate, lower-priority track.

### Puff as OAuth / OIDC provider

* [x] `sql/apps.sql` — registered OAuth clients ("linked apps"). Apps are **globally registered** by the operator (not by orgs), so the table has no `org_uuid` and no organisational FK at all: `app_uuid` PK, `app_name`, `client_id` (unique), `client_secret` stored hashed (reuse `src/utilities/hashing.ts`), `redirect_uris STRING[]` (exact-match allowlist), `app_active`, `app_created_at`. Any organisation can grant its users/teams entitlements for any registered app — there is no notion of an "owning" org.
* [x] OAuth state in two tables. **Access tokens are JWTs**, signed with the same Web Crypto key infra as the ID tokens (see below), so they are validated by signature and never stored. Only the DB-backed grants live here:
  * `sql/oauth_grants.sql` — authorization codes + refresh tokens, both expiring and single-use. PK `grant_value` (the code or refresh-token string), FKs to `users` + `apps` (both `ON DELETE CASCADE`), `grant_type` discriminator (`'authorization_code'` | `'refresh_token'`), `scopes STRING[]`, PKCE fields (`redirect_uri`, `code_challenge`, `code_challenge_method`) on auth-code rows, `parent_grant_value` for the rotation chain (plain column, not a self-FK — keeps cleanup decoupled from reuse-attack containment, which walks the chain explicitly in app code), `expires_at`, `is_used`. Indexes for FK columns, `expires_at` cleanup, and `parent_grant_value` chain walks.
  * `sql/oauth_consents.sql` — remembered per-(user, app) scope grant so the consent screen is skipped on the next OAuth round-trip. Composite PK `(user_uuid, app_uuid)`, FKs to both (`ON DELETE CASCADE`), `scopes STRING[]`, `granted_at`. No expiry, no `is_used` — revoking is a DELETE. UPSERT on re-consent.
* [x] Authorization Code flow with PKCE (OAuth 2.1 — no implicit flow). All endpoints are **confidential-client only** — every app has a `client_secret` (chosen 2026-05-20; see [[apps-are-global]]); public/PKCE-only clients are deferred. PKCE is still mandatory on `/oauth/token` (OAuth 2.1 requirement regardless of client type), `S256` only.
  * `functions/oauth/_middleware.ts` opens a `pg` client for the `/oauth/*` tree. The cross-origin write guard from `/api/db/_middleware.ts` is deliberately omitted — OAuth endpoints are reached cross-site by design.
  * `functions/oauth/authorize.ts` — GET validates the request (response_type, client_id, redirect_uri allowlist, code_challenge + S256, scope), session-checks via the `session_token` cookie (redirects to `/login` with the existing `login_next` cookie when absent), and either skips the consent screen (when `hasConsentFor(...)` covers the requested scopes) or server-renders a minimal consent page. POST processes the consent submission, `upsertConsent`s on approve, and redirects to the client with `code` + `state`. Protocol errors after redirect_uri validation are returned via redirect (RFC 6749 §4.1.2.1); pre-validation errors render a static error page so an attacker can't pivot through an unvalidated URI.
  * `functions/oauth/token.ts` — POST only. Authenticates the client via HTTP Basic OR body params (`client_secret_basic` / `client_secret_post`). Two grant types: `authorization_code` (consume the code atomically, verify PKCE, mint access token + ID token + optional refresh token when `offline_access` was granted) and `refresh_token` (consume + rotate via `parent_grant_value`; suspected reuse triggers `revokeRefreshTokenChain` on the whole rotation chain). JSON responses per RFC 6749 §5.1 / §5.2; `Cache-Control: no-store`.
  * `functions/oauth/userinfo.ts` — GET with `Authorization: Bearer <jwt>`. Verifies the access token via `verifyJwt` (current OR previous key, see [[apps-are-global]] sibling memory on rotation), reads the `scope` claim baked into the token, and returns `{ sub, name?, email?, email_verified? }` depending on which OIDC scopes are present. 401s use `WWW-Authenticate: Bearer error=...` per OIDC §5.3.2.
  * `functions/.well-known/openid-configuration.ts` — OIDC discovery doc: issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `id_token_signing_alg_values_supported: ["ES256"]`, `scopes_supported`, `claims_supported`, `token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]`.
  * Domain modules: `src/apps.ts` (read by UUID/client_id, `verifyAppCredentials` against the hashed `client_secret`, `hashClientSecret` for operator-side registration), `src/oauth-grants.ts` (`createAuthorizationCode` / `consumeAuthorizationCode` / `createRefreshToken` / `consumeRefreshToken` / `revokeRefreshTokenChain`), `src/oauth-consents.ts` (`readConsent` / `upsertConsent` / `revokeConsent` / `hasConsentFor`), `src/oauth.ts` (scope parsing / `verifyPkce` S256-only / `oauthErrorResponse` / `oauthRedirectErrorUrl` / `claimsForScopes`).
  * Lifetimes: authorization code 5 min, access + ID token 1 hour, refresh token 30 days. Schema change: `sql/oauth_grants.sql` gained a `nonce STRING NULL` column (`createAuthorizationCode` accepts it; `buildIdToken` echoes it into the ID token only on the initial exchange — per OIDC §12.1 it is not re-issued during refresh).
* [x] ID tokens (and access tokens) are signed JWTs via Web Crypto.
  * Algorithm: **ES256** (ECDSA P-256). Header `kid` is the RFC 7638 thumbprint of the public JWK, so it is deterministic from the key material.
  * Storage: env-var bindings, not a DB table. `OAUTH_SIGNING_KEY_PRIVATE` (secret) holds the active private JWK; the matching public key is derived from it at runtime, so no separate active-public binding is needed. `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` (optional, non-secret) holds the retired public JWK during a rotation overlap window.
  * Rotation: **manual operator action**, not a cron job. Generator + step-by-step in `scripts/generate-oauth-key.mjs`; full procedure in `docs/Operations.md → OAuth signing-key rotation`. Overlap window keeps in-flight JWTs valid until they expire (~1h); the operator clears the previous-public binding after that.
  * Modules: `src/oauth-keys.ts` (key loading + public derivation + RFC 7638 thumbprint), `src/oauth-jwt.ts` (`signJwt` / `verifyJwt` — checks current AND previous keys, no `exp`/`nbf` enforcement so the caller picks the policy).
  * Published via `functions/.well-known/jwks.json.ts` (advertised as `application/jwk-set+json`, 60-second cache). Discovery doc (`/.well-known/openid-configuration`) lands with the OAuth endpoints below.
* [x] Scopes & claims: three new puff-specific OIDC scopes — `puff:memberships` (the user's orgs), `puff:roles` (their org + team role assignments), and `puff:entitlements` (tier + perms resolved against the requesting app's owner namespace for the org context the grant was bound to). `claimsForScopes` widened to drive every flag; ID-token (`buildIdToken`) and `userinfo` both emit the same payload via `src/oauth-claims.ts`. Org context arrives on `/authorize` via a new optional `org_uuid` query param (auto-resolved when the user has exactly one eligible org, prompted via the consent screen when there are several); `oauth_grants.org_uuid` propagates onto refresh tokens and into the access token's `org_uuid` claim. Discovery doc lists the new scopes / claims.
* [ ] Operator-only app-management UI — register/edit apps, view and rotate `client_secret`, manage redirect URIs. Endpoints under `functions/api/db/auth/admin/apps/`, gated by a global "operator" check (mechanism TBD — likely an env-var allowlist of `user_uuid`s, since the org/team RBAC in `src/permissions.ts` has no global tier). Until the UI exists, apps are registered via direct DB access.

### App entitlements & permissions

Decided 2026-05-19: **entitlements are KV rows under an app's owner namespace**, not a separate `app_user_grants` / `app_team_grants` schema. The Phase 6 KV work is the unified storage and resolution layer (see `Phase 6 → Key/value scoping`). Org and team RBAC stays code-defined in `src/permissions.ts`; only the data-driven, database-backed model — for **apps** — is KV-backed.

Updated 2026-05-21: apps declare a **licensing mode** at registration — one of `none` / `seat` / `usage` / `floating` — stored on `apps.app_licensing_mode` (CHECK-constrained, default `none`). The mode picks the gating semantics; the entitlement values still live in KV.

* [x] Added the **app subject + app owner** to the KV layer. New `sql/app_key_values.sql` (subject = `app_uuid → apps`) with the same shape as the other five subject tables, plus an extra owner column on all six: `owner_app_uuid STRING NULL` (FK → `apps`, CASCADE), with the generated `owner_id` column widened to `COALESCE(owner_user_uuid, owner_org_uuid, owner_app_uuid)` and the `one_owner` CHECK widened to sum the three to 1. Added `idx_*_owner_app` on every table. New `src/app-keyvalues.ts` mirrors the other subject modules; existing five SELECT lists now project `owner_app_uuid` alongside the older two.
* [x] Extended `src/utilities/keyvalues-shared.ts`'s `Owner` union with `{ type: "app", app_uuid }`. `ownerFilter` handles the new variant; `ownerInsertValues` returns a 3-tuple; `buildUpsertQuery` inserts the third owner column. `KeyValueRowCommon` (in `types.d.ts`) gained `owner_app_uuid: string | null`; new `AppKeyValueRow` extends it.
* [x] Added the **app tier** to `src/keyvalues-resolver.ts` as the final fallback. `ResolveSource` widened with `"app"`. The chain is now `user → team-role → org-role → team → org → app`. The app tier only fires when `owner.type === "app"` — it represents the app's own globally-applied default for any user that touches it, so a non-app owner namespace has no meaningful "app default" to fall back to (and the chain terminates at `org`).
* [x] **Licensing modes.** `apps.app_licensing_mode` (CHECK constrained: `none` / `seat` / `usage` / `floating`; default `none`) — `LICENSING_MODES` const + `isAppLicensingMode` guard in `src/apps.ts`. Reserved KV keys: `license:tier` (on user/team/org subject under app owner — the user's tier), `license:tiers:<name>` (on the app's self-owned subject — the menu of available tiers), `license:perms:<name>` (app-declared permission identifiers), `license:floating:max` (per-org pool size on the org subject under app owner; fallback to the app's self-owned default). The standard `perm:*` keys are the actual permission grants.
* [x] **Floating-seat tracking.** New `sql/app_floating_sessions.sql` table — composite PK `(app_uuid, org_uuid, user_uuid)` + `heartbeat_at` / `expires_at`, all CASCADE. `src/app-floating-sessions.ts` exposes `checkoutFloatingSeat` (atomic count-then-insert under SERIALIZABLE), `heartbeatFloatingSeat`, `releaseFloatingSeat`, `countActiveFloatingSeats`, `getFloatingPoolMax`, `reapStaleFloatingSessions`. The OAuth `/token` endpoint allocates on `authorization_code` issue and again on each `refresh_token` exchange; reuse-attack chain revocation also releases the seat. The scheduled cleanup reaps stale rows every 5 minutes.
* [x] **Org-scoped entitlement endpoints.** New tree under `functions/api/db/auth/organisations/[org_uuid]/apps/[app_uuid]/`: `_middleware.ts` resolves the app; `summary.ts` reads the licensing readout; `pool/{set,remove}.ts` manage the floating pool max; `org-entitlements/{list,set,remove}.ts` for the org subject; `users/[user_uuid]/entitlements/{list,set,remove}.ts` and `teams/[team_uuid]/entitlements/{list,set,remove}.ts` for the user and team subjects. All gated by new `org:entitlements:read/write` actions in `src/permissions.ts` (owner + admin can write; billing reads only). Key namespace is enforced by `validateEntitlementKey` in `src/utilities/entitlements-endpoint.ts` — only `license:tier` and `perm:*` are accepted (the app-declared `license:tiers:*` / `license:perms:*` keys are operator-only).
* [x] **Grantee-in-org constraint.** `assertGranteeInOrg` in `src/entitlements.ts` 404s any user/team grantee that isn't part of the granting org. Apps are global, so the constraint is "grantee belongs to the granting org", not "grantee belongs to the app's org".
* [x] **"Licensed" definition.** `isLicensed(dbClient, app, user, org)` in `src/entitlements.ts` branches on `app_licensing_mode`: `none` is always licensed; `usage` is licensed when the user is a member of the org; `seat` resolves `license:tier` via the standard KV chain; `floating` checks for a live `app_floating_sessions` row. `summariseLicensing` produces the per-org billing readout (assigned vs. active vs. pool max).

### Puff as OAuth client (federated / social login)

* [x] `sql/external_identities.sql` — links a third-party identity to a Puff user. `(provider, provider_user_id)` is the primary key, `user_uuid` FK (`ON DELETE CASCADE`); a user may link several providers. Companion `sql/federated_signup_tokens.sql` carries the verified provider data between the callback and the signup-confirmation POST (pre-user, so it cannot live in the generic `tokens` table).
* [x] Provider configs for GitHub, Google, and Microsoft — client id/secret pulled from `OAUTH_<PROVIDER>_CLIENT_ID` / `OAUTH_<PROVIDER>_CLIENT_SECRET` env vars; authorize/token/userinfo URLs + per-provider userinfo extractors in `src/oauth-providers.ts`. A provider with missing credentials is reported as "not configured" and its `/login/<provider>` endpoint 404s.
* [x] `GET /login/[provider]` redirects with `state` + S256 PKCE (stashed in a SameSite=Lax cookie); `GET /login/[provider]/callback` verifies state, exchanges the code via `src/oauth-outbound.ts`, fetches the userinfo (plus `/user/emails` for GitHub), and lands the user in one of three places: an existing link logs them in (bypassing 2FA, matching passkey behaviour); an authenticated caller gets the identity linked to their current account; anyone else gets a 15-minute `federated_signup_token` and is redirected to `/federated-signup?token=…` to confirm account creation.
* [x] Linking safety: per the 2026-05-21 decision, email-match auto-linking is _disabled_ — users with an existing Puff account must sign in first and link the provider from `/account`. `unlinkExternalIdentity` refuses to remove the last credential (must keep a password, a passkey, or another linked identity).
* [x] `public/login.html` — "Continue with GitHub / Google / Microsoft" buttons alongside the password and passkey forms. `public/account.html` gains a Linked accounts section (`/api/db/auth/external-identities/list` + `unlink`).

### Per-app key/value scope

* [x] With `apps` now defined, implement the per-**app** `key_values` scope flagged in Phase 6 — values owned by a linked app, distinct from per-user-of-that-app values — resolving the polymorphic-scope design tension against the concrete app model. Landed as `sql/app_key_values.sql` (subject = app), `src/app-keyvalues.ts`, the `owner_app_uuid` column on every KV table (any subject can carry app-owned rows), and the "app" tier in `src/keyvalues-resolver.ts`. The Phase 7 entitlement endpoints are the first real consumer — every entitlement row is `(subject = user/team/org, owner = app)`, and the app's own globally-applied defaults (declared tiers, declared perms, floating-pool default) are `(subject = app, owner = app)`. Polymorphic scope was rejected in favour of concrete typed tables so the schema can keep its `ON DELETE CASCADE` integrity.

### Hooks / extensibility system

* [x] **Hooks / extensibility system.** PHP had `_hooks/` + `puff_hook()` for pluggable behaviour (e.g. the `ldap-login` hook adding profile fields). Landed as `src/hooks/` — a dispatcher with a static listener registry, two listener `kind`s (`sync` blocks the response, `async` runs via `ctx.waitUntil`), an optional per-listener `filter`, and a single source-of-truth event vocabulary in `src/hooks/events.ts` with default-severity tiers. The default `audit` listener appends to `sql/audit_events.sql` (no FKs on the uuid columns — see the header comment in that file; an audit row outlives its referents by design). ~30 emit sites wired into account and org handlers; `src/cron.ts` tiers retention by severity (`debug` / `info` reaped after 90 days, `notice` and above kept indefinitely).
  * [x] Design extension points suited to the Workers bundle. The `HookListener` interface is the contract; new listeners are added by appending one line to `src/hooks/registry.ts`.
  * [x] Document the hooks (old-repo issue [#17](https://github.com/eustasy/puff-server/issues/17) notes the PHP hooks were never documented). See `docs/Operations.md → Audit events & hooks` for the listener model, event vocabulary, severity tiers, and the retention rule.

---

## Reference — already at parity or intentionally dropped

No action needed; recorded so the PHP-server comparison is complete.

* **GeoIP** — PHP bundled the MaxMind GeoLite2 database; this server gets `CF-IPCountry` from Cloudflare for free (used in session IP-country checks).
* **HSTS** — PHP had `hsts-attempt.php`; now a static `Strict-Transport-Security` header in `public/_headers`.
