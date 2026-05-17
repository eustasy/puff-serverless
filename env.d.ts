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
}
