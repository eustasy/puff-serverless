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

## Passwords

- Passwords are hashed with SHA-384 + random UUID salt via Web Crypto API (`crypto.subtle.digest`).
- Stored as `hash:salt` in the `secrets` table with `secret_type = 'puff_password_SHA-384'`.
- Minimum length: 12 characters (enforced server-side in `src/passwords.ts`).
- Passwords are checked against the HaveIBeenPwned API using k-anonymity (only the first 5 chars of the SHA-1 hash are sent).
- Password updates (`updatePassword` in `src/passwords.ts`) wrap disable-old + create-new in a `BEGIN/COMMIT` transaction so a partial failure cannot leave the user with no enabled password.

## Two-Factor Authentication

- TOTP-based using the `otplib` library.
- 2FA secrets are stored in the `secrets` table with `secret_type = 'totp_secret'`.
- Login with 2FA: initial password auth returns a short-lived `totp_verification_pending` token (15 min), then the user submits the TOTP code with that token.
- 2FA setup: secret is created with `is_enabled = FALSE`, enabled only after successful TOTP code verification.

## Tokens

- All tokens use `crypto.randomUUID()` for generation.
- Token types and their expirations:
  - `email_verification`: 24 hours.
  - `password_reset`: 24 hours.
  - `totp_verification_pending`: 15 minutes.
  - `sudo_elevation`: 15 minutes.
- Tokens are single-use: marked `is_used = TRUE` after consumption.
- Token expiration is checked server-side before use.
- **Development-only**: verification and reset links are currently `console.log`'d server-side (placeholder until email delivery is wired up). The two log sites are marked with `// SECURITY: remove before production` comments — see `src/users.ts` (registration verification link) and `functions/api/db/password/request.ts` (password-reset link). Removing them is required before any production deployment, since Cloudflare logs are not a safe delivery channel for verification tokens.

## Input Handling

- All SQL queries use parameterized `$1, $2, ...` placeholders — never string concatenation.
- Form inputs are validated at the beginning of each API handler before any business logic.
- Email format is validated using regex or HTML5 `type="email"` on the client.
- When reflecting user-controlled values into HTML response bodies or attributes, run them through `escapeHtml` from `src/utilities/escape.ts`. For JSON embedded inside HTML attributes (e.g. `hx-vals='...'`), use `escapeHtml(JSON.stringify(obj))`. The email endpoints under `functions/api/db/auth/email/` are the canonical examples.
- The password reset flow does not reveal whether an email exists (returns generic success either way).
- Adding an email that already belongs to a different user is treated identically to a real successful add in the response shape (no error, no diagnostic message). This prevents email-enumeration. See `src/emails.ts#createEmail` — both the upfront `readEmail` check and the `ON CONFLICT DO NOTHING` race path return the same success-shaped response.

## HTTP Security Headers

Configured in `public/_headers` (honored by Workers Static Assets):

- `Content-Security-Policy` — restricts script/style sources.
- `Strict-Transport-Security` — HSTS with `max-age=31536000; includeSubDomains`.
- `X-Frame-Options: DENY` — prevents clickjacking.
- `Permissions-Policy` — disables camera, microphone, geolocation, etc.
- `X-Robots-Tag: noindex` on `*.workers.dev` to prevent indexing of dev domains.
