// Augments the Wrangler-generated `Env` (see worker-configuration.d.ts) with
// operator-set runtime variables configured at deploy time — via the Cloudflare
// dashboard or `wrangler secret` — rather than in wrangler.jsonc `vars` or
// `.env`. Because those are not visible to `wrangler types`, it does not
// generate them, so they are declared (optional) here instead.
//
// Bindings and vars that ARE in wrangler.jsonc / .env (HYPERDRIVE,
// EMAIL_CHECK_RL, MAILTRAP_TOKEN, MAILTRAP_SENDER, MAILTRAP_SENDER_NAME,
// APP_URL, …) are generated automatically — do not redeclare them here.
//
// See ARCHITECTURE.md "Environment Variables" for defaults and behaviour.

interface Env {
  APP_NAME?: string
  COOKIE_SAMESITE?: string
  SECURE_COOKIE?: string
  SESSION_MAX_AGE_SECONDS?: string
  MAILTRAP_API_URL?: string
}
