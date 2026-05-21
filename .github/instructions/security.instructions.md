---
applyTo: "**"
---

# Security Instructions

## Authentication & Sessions

- Sessions are cookie-based: `session_token` cookie, always `HttpOnly`, with `SameSite` and `Secure` set from `COOKIE_SAMESITE` and `SECURE_COOKIE` env vars (defaults: `Lax` and unset — see `docs/Architecture.md`).
- Session tokens are 32-byte random hex strings (`randomBytes(32).toString("hex")`).
- The server-side session row expires after 7 days (hardcoded in `src/sessions.ts#createSession`); the cookie expiry is independently configured via `SESSION_MAX_AGE_SECONDS` (default 30 days). The effective session lifetime is whichever fires first — usually the DB row.
- Sessions are also invalidated if the user's IP country changes.
- Session verification happens in `functions/api/db/auth/_middleware.ts` — endpoints under `functions/api/db/auth/` are protected automatically.
- Login failures return generic "Invalid email or password" messages — never reveal whether the email exists during login.
- Three login paths grant a session: password (with optional 2FA gate), passkey (single-step — the passkey is both factors), or federated provider (single-step — the provider is the second factor). Each emits `account.login.success` after the session is granted.

## CSRF / cross-origin writes

- The cross-origin write guard in `functions/api/db/_middleware.ts` rejects state-changing requests (non-GET/HEAD/OPTIONS) whose `Sec-Fetch-Site` is not `same-origin`, falling back to an `Origin` match when `Sec-Fetch-*` is absent. Returns 403 with an HTML fragment.
- This closes the residual same-site CSRF gap that `SameSite=Lax` does not catch (sibling-subdomain attackers).
- The guard runs before the DB connection opens, so a cross-origin POST never reaches a handler.
- The only state-changing GET is `/api/db/email/verify` (token-gated, exempt — GET is a safe method). Don't add other state-changing GETs without explicit thought.

## Passwords

- Passwords are hashed with SHA-384 + random UUID salt via Web Crypto API (`crypto.subtle.digest`).
- Stored as `hash:salt` in the `secrets` table with `secret_type = 'puff_password_<algo>'`.
- Minimum length: 12 characters by default; the floor can be raised (not lowered) by setting `MIN_PASSWORD_LENGTH` via env var. When raised, a login with a now-too-short password is paused and the user is redirected to `/password-upgrade` to set a longer one before a session is granted.
- Optional policy toggles (env vars, all default off): `REQUIRE_NUMBER`, `REQUIRE_CAPITAL`, `REQUIRE_SPECIAL_CHAR`, `REQUIRE_NOT_COMPROMISED` (HIBP k-anonymity), `SHOW_ZXCVBN` (display strength estimate), `REQUIRE_ZXCVBN` (require zxcvbn score ≥ 3). When `REQUIRE_ZXCVBN` is on, the character-class toggles become suggestions; `MIN_PASSWORD_LENGTH` always applies as a hard floor. HIBP is fail-open: a network error is treated as passing.
- Old passwords are disabled (`is_enabled = FALSE`) rather than deleted when a password changes — they back the **password-reuse check** (`isPasswordReused` in `src/passwords.ts`) which rejects any current or previous password at change / reset time.
- Password updates (`updatePassword` in `src/passwords.ts`) wrap disable-old + create-new in a transaction (via `runInTransaction`) so a partial failure cannot leave the user with no enabled password.
- **Transparent hash-method upgrade on login**: a successful login with a password stored under an outdated algorithm transparently re-hashes it to the current preferred algo. Best-effort — a failed upgrade never blocks the login.

## Two-Factor Authentication

- TOTP-based using the `otplib` library.
- 2FA secrets are stored in the `secrets` table with `secret_type = 'totp_secret'`.
- Login with 2FA: initial password auth returns a short-lived `totp_verification_pending` token (15 min) set in a cookie, then the user submits the TOTP code with that token.
- 2FA setup: secret is created with `is_enabled = FALSE`, enabled only after successful TOTP code verification.
- **TOTP replay prevention**: `totp_used_codes` keyed on `(user_uuid, totp_code)` with `INSERT … ON CONFLICT DO NOTHING` — a code is accepted at most once within its acceptance window. Replays return failure. `verify()` uses `epochTolerance: 30` (±1 step for clock skew). Stale rows are reaped every 5 minutes by the `puff_purge_totp_used_codes` CockroachDB schedule (`sql/schedules.sql`).
- **2FA QR code** is rendered inline as `<svg>` via `uqr` — the TOTP secret never leaves the origin (older versions sent it to a third-party QR-image service, which was a leak).
- **2FA bypass** (`/api/db/2fa/bypass/{request,verify}`) emails a single-use link to a verified address (primary if verified, otherwise oldest-verified secondary) when the user has lost their authenticator. Refuses to send when a `password_reset` token was consumed in the last 24h, so email alone cannot reset the password (factor 1) AND bypass 2FA (factor 2) in the same window.

## Passkeys (WebAuthn)

- Stored in `passkeys`: `passkey_uuid` (PK), `user_uuid` (FK, cascade), `credential_id` (UNIQUE), `public_key`, `counter`, `transports`, `passkey_name`, `created_at`, `last_used_at`, `is_enabled`.
- Verified via `@simplewebauthn/server` (Web Crypto API; no Node `crypto` dependency).
- **Passkey login bypasses the 2FA gate** — the passkey itself satisfies both factors (matches federated-login behaviour).
- `deletePasskey` refuses to remove the user's last usable credential — they must keep at least one of: an active password, an active passkey, or a linked external identity.

## External identities (federated login)

- Stored in `external_identities`: composite PK `(provider, provider_user_id)`, FK to `users` (cascade).
- Providers: GitHub, Google, Microsoft. Per-provider `client_id` and `client_secret` in env vars (`OAUTH_<PROVIDER>_CLIENT_ID`, `OAUTH_<PROVIDER>_CLIENT_SECRET`). Missing credentials → provider is not advertised on the login page and its `/login/<provider>` route 404s.
- Federated login uses standard OAuth 2.1 Authorization Code with S256 PKCE; state nonce + verifier are stashed in a short-lived `oauth_state` cookie (HttpOnly, SameSite=Lax).
- **Email-match auto-linking is disabled** — users with an existing Puff account must sign in first and link the provider from `/account`. Prevents a hostile provider giving you a verified email you already own as a Puff user.
- `unlinkExternalIdentity` refuses to remove the last credential (same guard as passkeys).
- Microsoft's `/oidc/userinfo` omits `email_verified` — Puff infers it from the `tid` claim on the ID token: work/school tenants trust the email; the personal-MSA tenant (`9188040d-…`) does not.

## Tokens

- All tokens use `crypto.randomUUID()` for generation.
- Token types and their expirations (in `src/tokens.ts`):
  - `email_verification`: 24 hours.
  - `password_reset`: 24 hours.
  - `totp_verification_pending`: 15 minutes.
  - `password_upgrade`: 15 minutes.
  - `totp_bypass`: 1 hour.
  - `webauthn_registration_challenge` / `webauthn_authentication_challenge`: 5 minutes.
  - `sudo_elevation`: 15 minutes.
- **Consumption is atomic** — `consumeToken` issues a single `UPDATE … RETURNING` so used / expired / wrong-type / missing all collapse into one "invalid token" outcome with no TOCTOU race. **Always use `createToken` + `consumeToken`** for any new single-use-token flow.
- The `2fa/login` flow uses `readToken` as a deliberate non-consuming pre-check (it needs `user_uuid` to load the 2FA secret before verifying the TOTP code; a wrong code must not burn the token) — then `consumeToken` runs only after a valid code.

## Input Handling

- All SQL queries use parameterised `$1`, `$2`, ... placeholders — never string concatenation.
- Form inputs are validated at the beginning of each API handler before any business logic.
- Email format is validated using regex or HTML5 `type="email"` on the client.
- When reflecting user-controlled values into HTML response bodies or attributes, run them through `escapeHtml` from `src/utilities/escape.ts`. For JSON embedded inside HTML attributes (e.g. `hx-vals='...'`), use `escapeHtml(JSON.stringify(obj))`. The email endpoints under `functions/api/db/auth/email/` are the canonical examples.
- The password reset flow does not reveal whether an email exists (returns generic success either way).
- Adding an email that already belongs to a different user is treated identically to a real successful add in the response shape (no error, no diagnostic message). This prevents email-enumeration. See `src/emails.ts#createEmail` — both the upfront `readEmail` check and the `ON CONFLICT DO NOTHING` race path return the same success-shaped response.

## OAuth provider (Puff issues tokens)

- Authorization Code flow with PKCE (`S256` only — OAuth 2.1; no implicit flow).
- Confidential clients only: every app has a hashed `client_secret`. Authenticated on `/oauth/token` via HTTP Basic or body params.
- Access tokens are signed JWTs (`ES256`), not stored — verified by signature. Authorization codes and refresh tokens are stored in `oauth_grants` and consumed atomically.
- Refresh-token rotation chains: each rotation links via `parent_grant_value`. Suspected reuse triggers `revokeRefreshTokenChain` on the whole chain (defence against stolen-refresh-token replay).
- Signing key lives in the `KV_OAUTH_KEYS` namespace (`oauth:keys:active` / `oauth:keys:retired`); a daily cron rotates it automatically once a week via `src/oauth-keys-rotation.ts`. The Wrangler secrets `OAUTH_SIGNING_KEY_PRIVATE` / `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` remain as a migration fallback (`src/oauth-keys.ts` reads KV first). The retired key stays in JWKS for a two-hour overlap so in-flight tokens validate through the transition. Full procedure and operator endpoints in `docs/Operations.md → OAuth signing-key rotation`.

## Audit log

- Every account and organisation mutation emits a structured event via `src/hooks/`. The default listener writes a row to `audit_events`.
- Audit rows are **append-only and FK-less** — they outlive their referents by design. Reporting code joins with `LEFT JOIN`.
- Severity is tiered: `info` / `debug` reaped after 90 days; `notice` and above kept indefinitely. Use `audit_events` for incident investigation and compliance evidence.
- Don't store sensitive payloads in `event_metadata` (passwords, full tokens) — they end up in the table verbatim. The `target_label` column is for human-readable handles (email, role name); fine to populate.

## HTTP Security Headers

Configured in `public/_headers` (honoured by Workers Static Assets):

- `Content-Security-Policy` — restricts script/style sources. Includes `report-uri /api/csp-report` and `report-to csp-endpoint`; violations land at `functions/api/csp-report.ts` and are logged via `console.warn`.
- `Reporting-Endpoints: csp-endpoint="/api/csp-report"` — modern Reporting API.
- `Strict-Transport-Security` — HSTS with `max-age=31536000; includeSubDomains`.
- `X-Frame-Options: DENY` — prevents clickjacking.
- `Permissions-Policy` — disables camera, microphone, geolocation, etc.
- `X-Robots-Tag: noindex` on `*.workers.dev` to prevent indexing of dev domains.
