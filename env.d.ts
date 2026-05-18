// Augments the Wrangler-generated `Env` (see worker-configuration.d.ts).
//
// `wrangler types` only generates types for what it can see in source:
// bindings and `vars` in wrangler.jsonc, plus whatever a local `.env` /
// `.dev.vars` happens to hold. Two categories are therefore NOT reliably
// generated — they are declared here so the `Env` type is stable everywhere
// (local, CI, production):
//
//   * Secrets (set via `wrangler secret put`) are never visible to
//     `wrangler types`. `MAILTRAP_TOKEN` is only generated when a local
//     `.env` holds it, so it is absent in CI. It is declared `required`
//     (not optional) on purpose: a local `.env` generates it as required,
//     and an optional re-declaration would conflict with that via `extends`.
//   * Operator-set runtime vars configured at deploy time (dashboard) rather
//     than in wrangler.jsonc — optional, with defaults applied in code.
//
// Bindings and `vars` that ARE in wrangler.jsonc (HYPERDRIVE, EMAIL_CHECK_RL,
// MAILTRAP_SENDER, MAILTRAP_SENDER_NAME, APP_URL) are generated automatically —
// do not redeclare them here.
//
// See ARCHITECTURE.md "Environment Variables" for defaults and behaviour.

interface Env {
  MAILTRAP_TOKEN: string
  APP_NAME?: string
  COOKIE_SAMESITE?: string
  SECURE_COOKIE?: string
  SESSION_MAX_AGE_SECONDS?: string
  MAILTRAP_API_URL?: string
  // Minimum password length. Optional; defaults to 12 (DEFAULT_MIN_PASSWORD_LENGTH).
  // Can only raise the minimum above the built-in floor — see minPasswordLength.
  MIN_PASSWORD_LENGTH?: string
  // Password-policy toggles. Set to "true" to enable; absent/any other value = disabled.
  // See ARCHITECTURE.md "Environment Variables" and src/passwords.ts passwordConfig().
  REQUIRE_NUMBER?: string
  REQUIRE_CAPITAL?: string
  REQUIRE_SPECIAL_CHAR?: string
  REQUIRE_NOT_COMPROMISED?: string
  SHOW_ZXCVBN?: string
  /** When "true", zxcvbn score ≥ 3 is the hard gate; REQUIRE_NUMBER /
   *  REQUIRE_CAPITAL / REQUIRE_SPECIAL_CHAR become suggestions, not rules. */
  REQUIRE_ZXCVBN?: string
  // WebAuthn / Passkey settings. Optional; defaults derived from APP_URL and APP_NAME.
  WEBAUTHN_RP_ID?: string
  WEBAUTHN_RP_NAME?: string
}
