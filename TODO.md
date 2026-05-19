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
- [x] **CSP violation reporting.** PHP exposed `api/csp_report.php` and logged breaches.
  - [x] Added `report-uri /api/csp-report` and `report-to csp-endpoint` to both CSP lines in `public/_headers`, plus a `Reporting-Endpoints` header naming `csp-endpoint` for the modern Reporting API.
  - [x] Added `functions/api/csp-report.ts` — a DB-free, unauthenticated collector that parses both the legacy `{ "csp-report": … }` body and the modern `application/reports+json` array, logs each violation (`console.warn`, capped per request), and returns `204`.
- [x] **Review 2FA QR generation.** The QR code was generated by sending the `otpauth://` URI — which embeds the TOTP secret — to the third-party `api.qrserver.com`, leaking every user's 2FA seed. Now rendered in the Worker as an inline `<svg>` via `uqr` (zero-dependency, Workers-native); the secret never leaves the origin. Inline SVG is page markup, so it is also unaffected by the page's `default-src https:` CSP (a `data:` URI would not be).
- [x] **2FA bypass flow.** Replaced the "do a password reset" fallback (which never actually bypassed 2FA) with a dedicated email-based flow.
  - [x] `POST /api/db/2fa/bypass/request` — identifies the user from the `totp_verification_token` cookie (validated via a non-consuming `readToken`, so a retry never burns it), emails a one-time link to the first _verified_ address on the account, and returns a generic acknowledgement that never reveals account/email state.
  - [x] `GET /api/db/2fa/bypass/verify?token=…` — the emailed link; `consumeToken` atomically spends the `totp_bypass` token, `createSession` issues the session, and the response sets the session cookie, clears the pending cookie, and `Location`-redirects to `/account`. Token-gated GET, exempt from the cross-origin guard like `/api/db/email/verify`.
  - [x] `createBypassToken` (`src/tokens.ts`, type `totp_bypass`, 1-hour expiry), `twoFactorBypassEmail` template, `sendTwoFactorBypassEmail` mailer helper.
  - [x] `public/2fa.html` — the TODO comment is replaced with a `<details>` "Lost access to your authenticator?" section that POSTs to the request endpoint. The two factors are preserved: the password (already proven to reach the 2FA step) plus control of the verified inbox.

> **Phase 2 complete.**

## Phase 3 — Account & password parity

Core feature parity with the PHP server, focused on the account/password lifecycle.

- [x] **Password-hash upgrade-on-login.** PHP transparently re-hashed outdated methods on successful login (`password.upgrade.php`) plus a batch endpoint. This server only knows `puff_password_SHA-384` with no migration path.
  - [x] Add hash-method detection / "needs upgrade" check. (`PREFERRED_PASSWORD_ALGO` + `passwordNeedsUpgrade()` in `src/utilities/hashing.ts`; surfaced as `needs_upgrade` on `password_verify`.)
  - [x] Re-hash transparently on successful login. (`user_login` calls `updatePassword` when `needs_upgrade` is set — best-effort, never blocks the login.)
- [x] **Disallow re-using previous passwords** — issue [#22](https://github.com/eustasy/puff-server/issues/22) (Medium). Disabled password hashes are already retained in `secrets`, so reuse can be detected at change/reset time. (`passwordReused()` in `src/passwords.ts` re-hashes the candidate with every stored row's salt+algo; enforced in `password/change.ts` and `password/set.ts`. The reset flow runs the check before consuming the token, so a reused password doesn't burn the reset link.)
- [x] **Minimum-password-length setting with force-upgrade on login** — issue [#23](https://github.com/eustasy/puff-server/issues/23) (Medium). Length is currently hardcoded to 12 in `src/passwords.ts`; make it configurable and re-check on login. (`MIN_PASSWORD_LENGTH` env var via `getMinPasswordLength()`; `password_requirements` parameterised. `user_login` re-checks the plaintext length and, when too short, returns `password_upgrade_required` — `user/login.ts` issues a `password_upgrade` token and redirects to the new `/password-upgrade` page, handled by `functions/api/db/password/upgrade.ts`, which completes the login or hands off to 2FA.)
- [x] **Prompt when an old (disabled) password is used in a login attempt** — issue [#21](https://github.com/eustasy/puff-server/issues/21) (Low). (`user_login` runs `passwordReused` on a failed verify; since the active password already failed, any hit is a previous password — the user gets a "you previously used this password" prompt instead of the generic failure.)
- [x] **Log the user in when registration uses an existing username+password pair** — issue [#20](https://github.com/eustasy/puff-server/issues/20) (Low). (When registration hits an existing email, `register.ts` runs `user_login`; a matching password logs the user in — session, 2FA, or password-upgrade — via the shared `loginOutcomeResponse` helper. A wrong password keeps the generic 409.)
- [x] **Account disable vs. delete.** PHP distinguished `member.disable` (reversible: `Active=0` + kill all sessions) from `member.destroy`. This server only has soft-delete via `user_active`.
  - [x] Add a reversible disable that also terminates all sessions. (`disableUser` in `src/users.ts` — transactional `user_active = FALSE` + `terminateAllSessions`. `user_login` now rejects disabled accounts after a proven password.)
  - [x] Add a re-enable flow. (`enableUser` in `src/users.ts`.)
  - [x] The old `deleteUser` (which only soft-deleted) is now a real permanent hard delete — a single `DELETE FROM users`, with all child rows removed by `ON DELETE CASCADE` foreign keys (`sql/*.sql` updated; existing databases need the cascade `ALTER`).
- [x] **WebAuthn / Passkeys.** Passkey login does not trigger the 2FA gate — the passkey itself satisfies both factors.
  - [x] `sql/passkeys.sql` — new table with `credential_id UNIQUE` index for O(1) lookup during authentication; FK to `users` with `ON DELETE CASCADE`.
  - [x] `src/passkeys.ts` — domain module: `listPasskeys`, `getPasskeyByCredentialId`, `savePasskey`, `updatePasskeyCounter`, `deletePasskey`, `getUserByUsername`, `getRpConfig`. RP ID defaults to hostname of `APP_URL`; RP name defaults to `APP_NAME`.
  - [x] `createWebAuthnToken` added to `src/tokens.ts` — inserts a caller-supplied challenge (base64url bytes) as `token_value`, so the challenge and the look-up key are the same string. Token types: `webauthn_registration_challenge`, `webauthn_authentication_challenge` (5-minute TTL each).
  - [x] Registration endpoints under `functions/api/db/auth/passkeys/` (authenticated): `register/start.ts` generates options + challenge token + cookie; `register/complete.ts` verifies via `@simplewebauthn/server`, saves credential; `list.ts` returns HTML fragment; `delete.ts` removes (user-ownership guard).
  - [x] Authentication endpoints under `functions/api/db/passkeys/authenticate/` (unauthenticated): `start.ts` generates auth options (enumeration-safe: always returns valid JSON even if username absent); `complete.ts` consumes token atomically, verifies response, updates counter, grants session **directly** — no `has2fa` check.
  - [x] `public/assets/webauthn.js` — minimal ES module using raw `navigator.credentials` API; no bundler or third-party browser library needed. Base64url encode/decode helpers included.
  - [x] `public/account.html` — Passkeys section (list + register button) with `hx-trigger="passkeysChanged from:body"` pattern matching the 2FA section.
  - [x] `public/login.html` — passkey login form (username input + "Use Passkey" button) below the password form.
  - [x] New env vars: `WEBAUTHN_RP_ID` (default: hostname from `APP_URL`), `WEBAUTHN_RP_NAME` (default: `APP_NAME`).
  - [x] `@simplewebauthn/server` v13 added (uses Web Crypto API — Workers-native; no Node crypto dependency).

## Phase 4 — Extended capabilities & integrations

Larger, optional-scope features. Each is independent and can be scheduled on demand.

- [x] **Per-user key/value store.** PHP had a `KeyValues` table and `Puff_Member_Key_*` functions (create/value/update/destroy/like) for arbitrary per-user metadata.
  - [x] Add a `key_values` table to `sql/` — `(user_uuid, kv_key)` composite PK, `ON DELETE CASCADE` to `users`.
  - [x] Add `src/keyvalues.ts` with the CRUD envelope helpers (`readKeyValue`, `readKeyValues`, `searchKeyValues`, `setKeyValue`, `deleteKeyValue`). `setKeyValue` is an upsert covering PHP `create` + `update`; `searchKeyValues` is the `like` equivalent with LIKE wildcards escaped. A per-user key cap (`MAX_KEYS_PER_USER`) guards against abuse.
  - [x] Add endpoints under `functions/api/db/auth/keyvalues/` — `list` (GET, optional `?key=` substring filter), `set` (POST upsert), `remove` (POST delete) — plus a "Stored Data" section in `public/account.html`.

## Phase 5 — Developer experience & polish

Non-blocking quality work; pick up alongside related changes.

- [x] **Consistent function names.** Renamed across all `src/` modules and call sites: snake_case → camelCase (`password_verify` → `verifyPassword`, `password_requirements` → `passwordRequirements`, `password_requirements_html` → `passwordRequirementsHtml`, `user_register` → `registerUser`, `user_login` → `loginUser`); verb/action alignment (`listSessionsForUser` → `readSessions`, `terminateSpecificSession` → `terminateSession`, `getMinPasswordLength` → `minPasswordLength`, `passwordReused` → `isPasswordReused`); and disambiguated the old `loginUser` (timestamp-touch helper) → `updateLastLogin` to free the name for the main login function. Skipped: `usedToken`, `has2fa`, `existsEmail`, `verifyEmailByToken` — left as-is by design.
- [x] **Consistent function descriptions.** Added JSDoc to all undocumented `src/` exports (`2fa.ts` × 6, `email-templates.ts` × 3); corrected four stale `@returns {Promise<boolean>}` in `passwords.ts` to describe the actual Envelope shapes; disambiguated the identical descriptions on `passwordRequirements` / `passwordRequirementsHtml`; improved vague "An object indicating success or failure" returns in `emails.ts`; removed redundant `(Optional)` text from bracketed params in `sessions.ts`.
- [x] **Do not log sensitive data.** Removed email address (PII) from password-reset "not found" log in `functions/api/db/password/request.ts`; removed `session_id` (auth credential) from the `terminateSession` error log in `src/sessions.ts`. All other console calls log only error objects, UUIDs, or internal status strings.
- [x] **Add a password-strength estimator (Dropbox `zxcvbn`) with configurable policy.** `zxcvbn` npm package added. `PasswordConfig` interface and `passwordConfig(env)` added to `src/passwords.ts`; all five requirement endpoints updated to pass the full config. New env vars: `REQUIRE_NUMBER`, `REQUIRE_CAPITAL`, `REQUIRE_SPECIAL_CHAR`, `REQUIRE_NOT_COMPROMISED`, `SHOW_ZXCVBN`, `REQUIRE_ZXCVBN`. When `REQUIRE_ZXCVBN` is set, score ≥ 3 is the hard gate and the individual character-class rules become suggestions; `MIN_PASSWORD_LENGTH` always applies. `REQUIRE_NOT_COMPROMISED` makes the HIBP check a hard gate (fail-open on network error). `passwordRequirements` is now async to support the HIBP network call.
- [x] **Reuse existing token in resend.** `email/resend.ts` now queries for an unexpired, unused `email_verification` token before calling `createEmailToken` — repeated resend clicks reuse the same token rather than accumulating new ones. (`readToken` was removed; it only looks up by `token_value`, which the resend flow does not have.)
- [x] **Verify password-requirements assertions.** Both regexes confirmed correct; stale TODO comment removed. `hasSpecial` (`/[^a-zA-Z\d]/`) matches spaces, which is intentional — a space counts as a special character.
- [x] **Sitemap generation.** `functions/sitemap.xml.ts` serves `/sitemap.xml` dynamically from `context.env.APP_URL` — covers `/`, `/login`, `/register`, `/reset/request`; excludes authenticated and token-gated pages. `public/robots.txt` added pointing to the sitemap.
- [x] **.html auth handling.** `functions/_middleware.ts` (root middleware) guards static HTML pages in two groups. Group A redirects to `/login` (302) when the required cookie is absent — `/account` + `/logout` need `session_token`; `/2fa` + `/password-upgrade` need their mid-login flow-token cookie (`totp_verification_token` / `password_upgrade_token`) — presence-only, the API layer does the real token check. Group B redirects logged-in users away from `/login` + `/register` to `/account`; this one is DB-verified (opens a short-lived `pg` connection only when a `session_token` cookie is actually present, fails open) so a stale/terminated session cookie cannot trap a user on `/login`. Requires `assets.run_worker_first` listing all six paths in `wrangler.jsonc` — static assets are served before the Worker by default, so the middleware would otherwise never run — plus `assets.binding: "ASSETS"` so `context.next()` can fall through to `env.ASSETS.fetch()`.
- [x] Transactions are always run in serializable isolation level
- [x] **Add a test suite.** [Vitest](https://vitest.dev) unit tests in `test/`, one `*.test.ts` per `src/` module (221 tests). Run with `npm test`. Tests run in plain Node with no real database: a fake `pg` client (`test/helpers/fake-db.ts`) scripts query responses by SQL match, and `test/helpers/fake-env.ts` builds a minimal `Env`. `test/**` is in the `tsconfig` `include` so `npm run typecheck` covers tests. (Old-repo issue [#16](https://github.com/eustasy/puff-server/issues/16) raised the same gap.)

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

**Roles.** Phase 6 ships a fixed, code-defined role set (text discriminators
validated in `src/`, matching the `secret_type` / `token_type` idiom). Phase 7
adds per-organisation **custom roles** and exposes them to linked OAuth apps as a
permission system — the schema and the capability helper below are shaped so that
is an additive migration, not a rewrite.

### Schema (`sql/`)

- [x] `sql/organisations.sql` — `org_uuid` PK, `org_name`, `org_slug` (unique, URL-safe), `org_active` (reversible-disable flag, mirroring `user_active`), `org_created_at`, `org_created_by` (FK → `users`, `ON DELETE SET NULL`).
- [x] `sql/teams.sql` — `team_uuid` PK, `org_uuid` (FK → `organisations`, `ON DELETE CASCADE`), `team_name`, `team_slug`, `team_created_at`. Unique `(org_uuid, team_slug)` — slugs are unique within an org, not globally; that index also covers the `org_uuid` FK.
- [x] `sql/organisation_members.sql` — organisation-scoped role grants. Composite PK `(org_uuid, user_uuid, role)`; FKs to `organisations` and `users`, both `ON DELETE CASCADE`; `added_at`, `added_by` (FK → `users`, `ON DELETE SET NULL`). `idx_organisation_members_user_uuid` serves the `user_uuid` FK and "orgs for a user" lookups.
- [x] `sql/team_members.sql` — team-scoped role grants. Composite PK `(team_uuid, user_uuid, role)`; FKs to `teams` and `users`, both `ON DELETE CASCADE`; `added_at`, `added_by`. `idx_team_members_user_uuid` serves the `user_uuid` FK and guest detection (team grants with no `organisation_members` row). There is deliberately no "team membership requires org membership" constraint.
- [ ] The `role` columns are plain text in Phase 6; Phase 7 migrates them to FKs into a `roles` table (additive — see Phase 7).
- [x] Schema import order extended to `users` → `organisations` → `teams` → `organisation_members` / `team_members`; ordering note updated in `CLAUDE.md`, `ARCHITECTURE.md`, and `database.instructions.md`.

### Roles & authorisation

- [x] Role set as a `src/permissions.ts` constant — organisation roles `owner` / `admin` / `member` / `billing`, team roles `lead` / `member` (`ORG_ROLES` / `TEAM_ROLES`). A user may hold any combination. `OWNER_ROLE` / `DEFAULT_ORG_ROLE` / `DEFAULT_TEAM_ROLE` exported for the domain modules; `isOrgRole` / `isTeamRole` type guards validate role names from request input.
- [x] `can(roles, action)` capability helper — resolves a role set to a boolean for a typed action (`OrgAction` / `TeamAction`, e.g. `org:update`, `org:teams:create`, `team:members:add`). The action prefix selects the scope. Endpoints check the capability, never a raw role string. Phase 6 backs it with a code-defined matrix; Phase 7's `role_permissions` table swaps in behind it with no call-site changes.
- [ ] `owner` is privileged: an organisation must always retain at least one `owner` (guard lives in `src/` — see Lifecycle below).
- [ ] Owners can grant any role to any user: `addOrgMember` and the team equivalents accept a `user_uuid` with no prior relationship to the org — this is how an external user becomes a guest or a member.

### Domain modules (`src/`)

Each new module follows the existing conventions: `dbClient` first, structured
envelopes, no HTTP. Multi-step writes use `runInTransaction`.

- [ ] `src/organisations.ts` — `createOrganisation` (transactional: insert org + add the creator as `owner`), `readOrganisation`, `updateOrganisation`, `disableOrganisation` / `enableOrganisation` (reversible, mirroring `disableUser`), `deleteOrganisation` (hard delete; cascade reaps teams + memberships), `listOrganisationsForUser`.
- [ ] `src/teams.ts` — `createTeam`, `readTeam`, `updateTeam`, `deleteTeam`, `listTeams` (for an org).
- [ ] `src/memberships.ts` — `addOrgMember` / `removeOrgMember` / `setOrgMemberRoles`, `listOrgMembers`, the team equivalents, and `getUserRoles(dbClient, user_uuid, scope)` returning every role a user holds in an org or team.

### Endpoints & routing (`functions/api/db/auth/`)

- [ ] `organisations/` — `list` (GET, the caller's orgs) and `create` (POST).
- [ ] `organisations/[org_uuid]/_middleware.ts` — resolves the caller's full role set for the org (organisation-level grants **and** team-level grants within it, so guests are recognised) into `context.data`; returns `403` (HTML fragment) only when the caller holds no role at all. Per-action authorisation is then a `can(...)` check at each endpoint. Pages Functions dynamic segments supply the `org_uuid` param.
- [ ] `organisations/[org_uuid]/` — `read` / `update` / `disable`; `members/` (list / invite / remove / set-roles); `teams/` (list / create).
- [ ] `organisations/[org_uuid]/teams/[team_uuid]/` — `read` / `update` / `delete` and `members/` (list / add / remove / set-roles). A team-level `_middleware.ts` confirms the team belongs to `[org_uuid]`.
- [ ] All responses are HTML fragments (`result-positive` / `result-negative`), consistent with the rest of the API.

### Member invitations

- [ ] Inviting by email must work whether or not the invitee already has an account. Add an `org_invitation` `token_type` on the existing `tokens` table (via the `createToken` / `consumeToken` pair); the token carries the org, the offered role(s), and the invited address.
- [ ] `POST …/members/invite` issues the token and emails a link (new `src/email-templates.ts` builder + `src/mailer.ts` helper). Accepting consumes the token: an existing user is added directly; a new visitor is routed through registration first, then added.

### Lifecycle & integrity

- [ ] Last-owner guard: `removeOrgMember` / `setOrgMemberRoles` reject any change that would leave an organisation with no `owner`.
- [ ] `deleteUser` interaction: cascades already drop a user's membership rows, but a user who is an org's sole `owner` would orphan it — `deleteUser` (or a pre-check) must reassign ownership or block. Decide and document.
- [ ] `disableUser` keeps memberships intact — a disabled user is gated at login by `user_active`, as today; org access is not separately stripped.

### Frontend (`public/`)

- [ ] `public/account.html` — an "Organisations" section listing the user's orgs and roles (HTMX fragment, `hx-trigger` refresh pattern like the existing 2FA / Passkeys sections).
- [ ] Organisation and team management pages — member lists, role editing, team CRUD — static HTML driven by HTMX, no client JS.

### Tests & docs

- [ ] A `test/*.test.ts` file per new `src/` module (`organisations`, `teams`, `memberships`, `permissions`), following the `FakeDb` pattern.
- [ ] `ARCHITECTURE.md` table-usage reference and `.github/instructions/database.instructions.md` updated for the four new tables and the import order.

### Key/value scoping (later)

- [ ] `key_values` is per-user today. Generalise the scope to any of: per-user, per-role, per-team, per-organisation, or per-**app** — a value owned by a linked OAuth app itself, distinct from a per-client / per-user-of-that-app value. This makes the store the backing data layer for the linked-app permission system.
- [ ] Design tension: a single polymorphic `(scope_type, scope_id)` pair loses the FK + `ON DELETE CASCADE` integrity the rest of the schema keeps. Options to weigh — one table per scope, one row with a nullable FK column per scope plus a `CHECK` that exactly one is set, or accepting the polymorphic pair with application-level cleanup. Decide alongside the Phase 7 app model.

### Open decisions

- [ ] **How "guest" is surfaced.** Derive it (a user with grants but no `member` org role) or store an explicit flag on `organisation_members`. Leaning derived — confirm.
- [ ] **v2 permission granularity.** Whether custom roles select from a platform-defined catalogue of actions or carry free-form permission strings that linked apps interpret themselves. Affects how Phase 7 exposes them.
- [ ] **Slug lifecycle.** Whether `org_slug` / `team_slug` are immutable after creation or renameable (and how to handle existing links/bookmarks if renameable).

## Phase 7 — OAuth identity provider & federated login

Two directions, plus the permission system that links them:

- **Puff as identity provider** — an arbitrary number of apps log their users in
  _with_ Puff-Serverless; Puff issues the tokens (OAuth 2.1 / OpenID Connect).
- **Puff as OAuth client** — users log in to Puff-Serverless itself _with_
  GitHub, Microsoft, or Google, federating those identities onto a Puff account.
- **Custom roles** (moved here from Phase 6) become the access model Puff exposes
  to the apps it logs users into.

OAuth-based external login is preferred over LDAP, which is kept below as a
separate, lower-priority track.

### Puff as OAuth / OIDC provider

- [ ] `sql/apps.sql` — registered OAuth clients ("linked apps"). `app_uuid` PK, `org_uuid` (FK → `organisations`, `ON DELETE CASCADE` — an app belongs to an org), `app_name`, `client_id` (unique), `client_secret` stored hashed (reuse `src/utilities/hashing.ts`), `redirect_uris` (exact-match allowlist), `app_active`, timestamps.
- [ ] `sql/oauth_grants.sql` — authorization codes, access tokens, and refresh tokens issued to apps: short-lived codes, refresh-token rotation, and a remembered per-(user, app) scope grant so consent is not re-prompted every time.
- [ ] Authorization Code flow with PKCE (OAuth 2.1 — no implicit flow). Endpoints under `functions/`: `/oauth/authorize` (consent screen; reuses the session cookie to identify the user), `/oauth/token` (code → tokens, refresh), `/oauth/userinfo`, `/.well-known/openid-configuration`, and a JWKS endpoint.
- [ ] ID tokens are signed JWTs via Web Crypto (Workers-native, as with WebAuthn). Decide signing-key storage and rotation, published through JWKS.
- [ ] Scopes & claims: standard OIDC (`openid`, `profile`, `email`) plus organisation/team membership and **role claims**, so an app receives the user's roles for _its_ org — this is where the custom roles below surface.
- [ ] App-management UI — org admins register/edit apps, view and rotate `client_secret`, manage redirect URIs. Endpoints under `functions/api/db/auth/organisations/[org_uuid]/apps/`.

### Custom roles & permission system (moved from Phase 6)

- [ ] `sql/roles.sql` — per-organisation custom roles. `role_uuid` PK, `org_uuid` FK (`ON DELETE CASCADE`), `role_key`, `role_name`; the built-in Phase 6 roles become a reserved/seeded set.
- [ ] `sql/role_permissions.sql` — maps a role to the permissions/actions it grants.
- [ ] Migrate the `role` text columns on `organisation_members` / `team_members` to FKs into `roles` — additive, since Phase 6 ships them as plain text.
- [ ] Switch `can(roles, action)` (Phase 6's capability helper) from the code constant to `role_permissions`, with no call-site changes.
- [ ] Expose roles/permissions to linked apps as OIDC claims and a `userinfo` field, so an app runs its own access checks from Puff-issued roles.

### Puff as OAuth client (federated / social login)

- [ ] `sql/external_identities.sql` — links a third-party identity to a Puff user. `(provider, provider_user_id)` unique, `user_uuid` FK (`ON DELETE CASCADE`); a user may link several providers.
- [ ] Provider configs for GitHub, Microsoft, and Google — client id/secret as Worker secrets; authorize/token/userinfo URLs.
- [ ] `GET /login/{provider}` → redirect with `state` + PKCE; `GET /login/{provider}/callback` → exchange the code, fetch the provider profile, then either log in the already-linked user, link to the currently-logged-in user, or auto-provision a new account on first sight.
- [ ] Linking safety: linking requires an authenticated session or a verified-email match; unlinking is allowed only while the account keeps another usable credential (password / passkey / another provider).
- [ ] `public/login.html` — "Continue with GitHub / Microsoft / Google" buttons alongside the password and passkey forms.

### Per-app key/value scope

- [ ] With `apps` now defined, implement the per-**app** `key_values` scope flagged in Phase 6 — values owned by a linked app, distinct from per-user-of-that-app values — resolving the polymorphic-scope design tension against the concrete app model.

### Hooks / extensibility system

- [ ] **Hooks / extensibility system.** PHP had `_hooks/` + `puff_hook()` for pluggable behaviour (e.g. the `ldap-login` hook adding profile fields).
  - [ ] Design extension points suited to the Workers bundle.
  - [ ] Document the hooks (old-repo issue [#17](https://github.com/eustasy/puff-server/issues/17) notes the PHP hooks were never documented).

### LDAP / Active Directory (lower priority)

- [ ] **LDAP / Active Directory authentication.** PHP `ldap.authenticate.php` bound against an LDAP server, auto-created the member on first login, then issued a session.
  - [ ] **Blocker:** raw LDAP sockets are not available on Workers — pick an LDAP-over-HTTP gateway or directory-provider API first.
  - [ ] Implement the bind + auto-provision-on-first-login flow.

## Phase 8 — Billing

- [ ] Maybe: optional second database. Old-repo issue [#19](https://github.com/eustasy/puff-server/issues/19) wanted multiple DB connections "by default" to separate domains (it names auth vs. billing). Deferred, no priority — single-DB is the right default, there is no second domain today, and splitting one would lose the cross-table FK / `ON DELETE CASCADE` integrity the schema relies on. Revisit only if a domain with its own scaling, regioning, or compliance boundary actually appears.

---

## Reference — already at parity or intentionally dropped

No action needed; recorded so the PHP-server comparison is complete.

- **GeoIP** — PHP bundled the MaxMind GeoLite2 database; this server gets `CF-IPCountry` from Cloudflare for free (used in session IP-country checks).
- **HSTS** — PHP had `hsts-attempt.php`; now a static `Strict-Transport-Security` header in `public/_headers`.
