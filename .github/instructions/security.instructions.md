---
applyTo: "**"
---

# Security Instructions

## Authentication & Sessions

- Sessions are cookie-based: `session_token` cookie, `HttpOnly; Secure; SameSite=Strict`.
- Session tokens are 32-byte random hex strings (`randomBytes(32).toString("hex")`).
- Sessions expire after 7 days and are invalidated if the user's IP country changes.
- Session verification happens in `functions/api/db/auth/_middleware.js` — endpoints under `functions/api/db/auth/` are protected automatically.
- Login failures return generic "Invalid email or password" messages — never reveal whether the email exists during login.

## Passwords

- Passwords are hashed with SHA-384 + random UUID salt via Web Crypto API (`crypto.subtle.digest`).
- Stored as `hash:salt` in the `secrets` table with `secret_type = 'puff_password_SHA-384'`.
- Minimum length: 12 characters (enforced server-side in `src/passwords.js`).
- Passwords are checked against the HaveIBeenPwned API using k-anonymity (only the first 5 chars of the SHA-1 hash are sent).

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

## Input Handling

- All SQL queries use parameterized `$1, $2, ...` placeholders — never string concatenation.
- Form inputs are validated at the beginning of each API handler before any business logic.
- Email format is validated using regex or HTML5 `type="email"` on the client.
- The password reset flow does not reveal whether an email exists (returns generic success either way).

## HTTP Security Headers

Configured in `public/_headers` for all Cloudflare Pages routes:

- `Content-Security-Policy` — restricts script/style sources.
- `Strict-Transport-Security` — HSTS with `max-age=31536000; includeSubDomains`.
- `X-Frame-Options: DENY` — prevents clickjacking.
- `Permissions-Policy` — disables camera, microphone, geolocation, etc.
- `X-Robots-Tag: noindex` on `*.workers.dev` to prevent indexing of dev domains.
