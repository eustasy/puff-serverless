# Deployment

Shipping Puff to production. Every step is intended to be runnable as-is — substitute placeholder values where marked. For local-dev setup see [Development.md](Development.md); for running-in-production tasks (cron, audit, key rotation, registering apps) see [Operations.md](Operations.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [1. Provision the database](#1-provision-the-database)
- [2. Create the Hyperdrive binding](#2-create-the-hyperdrive-binding)
- [3. Create the KV namespace](#3-create-the-kv-namespace)
- [4. Authenticate Wrangler](#4-authenticate-wrangler)
- [5. Push secrets](#5-push-secrets)
- [5a. Configure billing (Stripe)](#5a-configure-billing-stripe)
- [6. Set non-secret variables](#6-set-non-secret-variables)
- [7. Deploy](#7-deploy)
- [8. Attach a custom domain](#8-attach-a-custom-domain)
- [Post-deploy checklist](#post-deploy-checklist)
- [Re-deploys](#re-deploys)
- [Rolling back](#rolling-back)

## Prerequisites

- A Cloudflare account with Workers + Pages enabled.
- Node.js 22+ (`wrangler` refuses older versions).
- A CockroachDB Cloud account (or any Postgres-compatible managed DB you can reach from Cloudflare).
- A Mailtrap account with a verified sending domain.

The codebase deploys as a **single Cloudflare Worker bundle** even though it's authored as Pages Functions — the build step uses the Pages compiler; the deploy step is the Workers path. See [Architecture.md → Build model](Architecture.md#build-model) for context.

## 1. Provision the database

Production uses [CockroachDB Cloud](https://www.cockroachlabs.com/) (or any Postgres-compatible managed DB). Create a database, get a connection string, and import the schema in **foreign-key order**:

```sh
# Replace with the CockroachDB SQL client invocation for your cluster.
PSQL="cockroach sql --url='postgres://user:password@host:26257/puff?sslmode=verify-full'"

# 1. users (everything depends on this)
$PSQL < sql/users.sql

# 2. organisations / teams / their FK-dependent tables
$PSQL < sql/organisations.sql
$PSQL < sql/teams.sql
$PSQL < sql/organisation_members.sql
$PSQL < sql/team_members.sql
$PSQL < sql/organisation_invitations.sql

# 3. apps (no FK deps; can land any time after users)
$PSQL < sql/apps.sql

# 4. The six KV tables (depend on users, organisations, and apps)
$PSQL < sql/user_key_values.sql
$PSQL < sql/team_key_values.sql
$PSQL < sql/organisation_key_values.sql
$PSQL < sql/org_role_key_values.sql
$PSQL < sql/team_role_key_values.sql
$PSQL < sql/app_key_values.sql

# 5. OAuth-provider state (depend on users + apps; oauth_grants also FKs organisations)
$PSQL < sql/oauth_grants.sql
$PSQL < sql/oauth_consents.sql

# 6. App floating sessions (depends on apps + organisations + users)
$PSQL < sql/app_floating_sessions.sql

# 7. Federated login (external_identities depends on users; federated_signup_tokens has none)
$PSQL < sql/external_identities.sql
$PSQL < sql/federated_signup_tokens.sql

# 8. Per-user state (depend only on users)
$PSQL < sql/sessions.sql
$PSQL < sql/emails.sql
$PSQL < sql/secrets.sql
$PSQL < sql/tokens.sql
$PSQL < sql/totp_used_codes.sql
$PSQL < sql/passkeys.sql

# 9. Audit log (no FK dependencies — actor/target uuids are plain strings by design)
$PSQL < sql/audit_events.sql

# 10. Billing tables (organisations → billing_customers; apps + organisations
#     → subscriptions; subscriptions + organisations → invoices; apps +
#     organisations + users → usage_events + usage_rollups; apps → billing_pricing;
#     billing_webhook_events has no FK dependencies)
$PSQL < sql/billing_customers.sql
$PSQL < sql/subscriptions.sql
$PSQL < sql/invoices.sql
$PSQL < sql/usage_events.sql
$PSQL < sql/usage_rollups.sql
$PSQL < sql/billing_pricing.sql
$PSQL < sql/billing_webhook_events.sql

# 11. Row-Level TTL cleanup rules (CockroachDB v23.1+). Replaces the bulk
#     of what used to run in the Worker cron. Idempotent — re-applying is
#     safe (ALTER TABLE … SET just re-applies the same parameters).
$PSQL < sql/schedules.sql
```

The audit-events table is deliberately FK-less so its rows outlive their referents — see [Operations.md → Audit events & hooks](Operations.md#audit-events--hooks).

## 2. Create the Hyperdrive binding

Cloudflare Hyperdrive pools connections at the edge so the Worker doesn't open a fresh TLS handshake per request.

```sh
npx wrangler hyperdrive create puff-serverless \
  --connection-string="postgres://user:password@host:26257/puff?sslmode=verify-full"
```

Copy the printed Hyperdrive ID into `wrangler.jsonc` under `hyperdrive[].id` (the binding name `HYPERDRIVE` must stay — that's what `functions/api/db/_middleware.ts` opens its `pg` client against):

```jsonc
{
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<the id wrangler just printed>",
    },
  ],
}
```

## 3. Create the KV namespace

`KV_OAUTH_KEYS` holds the active OAuth signing key (and the retired one during a rotation overlap). A daily cron rotates it automatically once a week — see [Operations.md → OAuth signing-key rotation](Operations.md#oauth-signing-key-rotation).

```sh
npx wrangler kv namespace create KV_OAUTH_KEYS
```

Paste the printed `id` into `wrangler.jsonc` under `kv_namespaces[].id` (the binding name `KV_OAUTH_KEYS` must stay):

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "KV_OAUTH_KEYS",
      "id": "<the id wrangler just printed>",
    },
  ],
}
```

## 4. Authenticate Wrangler

Once per machine:

```sh
npx wrangler login
```

## 5. Push secrets

Secrets are encrypted by Cloudflare and never committed to the repo. Push each one with `wrangler secret put` — Wrangler prompts for the value interactively, or you can pipe it in with `echo`.

**Required for any deploy:**

```sh
# Outbound email
npx wrangler secret put MAILTRAP_TOKEN

# OAuth signing key — first-time seed for the KV oauth:keys:active entry.
# The rotation cron (daily tick, weekly rotation) takes over from there.
node scripts/generate-oauth-key.mjs
# then follow the printed `wrangler kv key put` command. The fallback
# secret path (OAUTH_SIGNING_KEY_PRIVATE) also works if you'd rather seed
# via `wrangler secret put` and let the next rotation tick copy it to KV.
```

**Optional — federated sign-in providers** (per provider you want to enable):

```sh
echo "<the client id>"     | npx wrangler secret put OAUTH_GITHUB_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GITHUB_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_GOOGLE_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_SECRET
```

The per-provider registration walkthrough (which form fields to fill in at GitHub / Google / Microsoft) is in [Operations.md → Adding a federated login provider](Operations.md#adding-a-federated-login-provider).

## 5a. Configure billing (Stripe)

Billing is optional at deploy time — skipping this section disables the billing surfaces but does not affect auth, OAuth, or any other feature. Complete it before accepting real subscriptions.

### Push Stripe secrets

```sh
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET
```

`STRIPE_SECRET_KEY` is the Stripe secret API key (`sk_live_…` or `sk_test_…`). `STRIPE_WEBHOOK_SIGNING_SECRET` is the signing secret for the webhook endpoint (starts with `whsec_`). Both are found in the Stripe Dashboard — the signing secret appears after you create the webhook endpoint in the next step. When `STRIPE_SECRET_KEY` is absent the billing domain functions return provider errors; when `STRIPE_WEBHOOK_SIGNING_SECRET` is absent `POST /api/billing/webhook` returns 503.

### Register the webhook endpoint

In the Stripe Dashboard → Developers → Webhooks → Add endpoint:

- **Endpoint URL**: `${APP_URL}/api/billing/webhook`
- **Events to send** (select all of these):
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.finalized`
  - `invoice.paid`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `invoice.voided`

After saving, copy the **Signing secret** (`whsec_…`) shown on the endpoint detail page and push it as `STRIPE_WEBHOOK_SIGNING_SECRET` above.

### Configure products and prices

For each app registered in Puff, create a Stripe Product (one per app) and one or more Prices (one per tier). Then seed the `billing_pricing` table with a row per `(app_uuid, tier)`, setting `provider_price_id` to the Stripe Price ID (`price_…`):

```sql
INSERT INTO billing_pricing
  (pricing_uuid, app_uuid, tier, price_cents, currency, billing_interval, provider_price_id)
VALUES
  (gen_random_uuid(), '<app_uuid>', 'basic', 1000, 'usd', 'month', 'price_…'),
  (gen_random_uuid(), '<app_uuid>', 'pro',   3000, 'usd', 'month', 'price_…');
```

`billing_interval` is free-form — it mirrors whatever Stripe's Price has configured and is shown in the billing UI. For `usage`-mode apps, create a **Billing Meter** in the Stripe Dashboard (Billing → Meters → Create meter) and note the `event_name` — it must match the `metric` string your apps send to `POST /api/billing/usage/[app_uuid]`. No `billing_pricing` row is required for pure usage-metered apps if there is no fixed per-seat price component.

### Stripe Tax

If you need to collect and remit tax, enable **Stripe Tax** in the Dashboard (Settings → Tax) and add your tax registrations. Puff stores an optional `tax_id` on `billing_customers` so you can supply it to Stripe for invoice display, but Puff itself does not branch billing logic on it — tax calculation and remittance are fully delegated to Stripe.

### Schema import order

The billing tables are already included in step [1. Provision the database](#1-provision-the-database) above (block 10 of the import sequence). No extra schema step is needed here.

## 6. Set non-secret variables

Edit `wrangler.jsonc`'s `vars` block before deploying:

```jsonc
{
  "vars": {
    "APP_URL": "https://auth.example.com",
    "APP_NAME": "PuffAuth",
    "MAILTRAP_SENDER": "noreply@example.com",
    "MAILTRAP_SENDER_NAME": "PuffAuth",
    "SECURE_COOKIE": "true",
    "COOKIE_SAMESITE": "Lax",
    "SESSION_MAX_AGE_SECONDS": "2592000",
    "MIN_PASSWORD_LENGTH": "12",
  },
}
```

The full variable catalogue is in [Architecture.md → Environment variables](Architecture.md#environment-variables). In particular:

- **`SECURE_COOKIE`** must be truthy in production so auth cookies are restricted to HTTPS.
- **`APP_URL`** must be the public origin (no trailing slash) — it builds email links and federated-login redirect URIs.
- **Password policy** (`REQUIRE_*`, `REQUIRE_ZXCVBN`, etc.) — pick what matches your security posture; `REQUIRE_NOT_COMPROMISED` is recommended.

## 7. Deploy

```sh
npm run deploy
```

This runs `npm run build` (which calls `wrangler pages functions build` to emit `dist/worker/`) and then `wrangler deploy`. The Cron Triggers declared as `triggers.crons` in `wrangler.jsonc` are registered automatically by `wrangler deploy` — no extra step.

Without a custom domain (step 7), the Worker is reachable at `puff-serverless.<account>.workers.dev`.

## 8. Attach a custom domain

The Worker should be served at its public origin so OAuth redirect URIs, email links, and cookies all line up with `APP_URL`. Two routes to do this:

**Dashboard.** Cloudflare dashboard → Workers & Pages → your worker → Settings → Triggers → Custom Domains → Add Custom Domain. Pick the hostname you set as `APP_URL`.

**Wrangler config.** Add a `routes` entry to `wrangler.jsonc`:

```jsonc
{
  "routes": [
    {
      "pattern": "auth.example.com/*",
      "custom_domain": true,
    },
  ],
}
```

Either way, keep `APP_URL` in sync with whichever hostname you pick — email verification links, OAuth callback URIs, and the `iss` claim on issued JWTs all derive from it.

## Post-deploy checklist

After the first deploy, verify each surface works end-to-end. The audit log (`audit_events`) is the cleanest place to confirm: every successful action writes a row.

- **Register a user** → `account.registered` row appears.
- **Log in** → `account.login.success` row.
- **Trigger a wrong-password attempt** → `account.login.failed` row with `event_outcome = 'failure'` and `actor_user_uuid = NULL`.
- **Request a password reset** → email arrives at the verified inbox; the link works.
- **Enable 2FA** → QR code renders inline (SVG, not a `data:` URL); `account.2fa.setup.verified` row.
- **`/.well-known/jwks.json`** returns the active public JWK.
- **`/.well-known/openid-configuration`** advertises endpoints matching your `APP_URL`.
- **Row-Level TTL is installed** — `SHOW SCHEDULES;` lists one `row-level-ttl` schedule for each of `totp_used_codes`, `app_floating_sessions`, `sessions`, `tokens`, `audit_events`. Recent runs: `WITH x AS (SHOW JOBS) SELECT * FROM x WHERE job_type = 'ROW LEVEL TTL' ORDER BY created DESC LIMIT 20;`
- **Worker cron is registered** — `wrangler deploy` prints `Cron Triggers: 0 0 * * *`. The daily tick drives `maybeRotateSigningKey` (see [Operations.md → OAuth signing-key rotation](Operations.md#oauth-signing-key-rotation)); it rotates the key once it is older than `OAUTH_KEY_ROTATION_INTERVAL_DAYS` (default 7), so the first rotation after seeding KV lands a week later.
- **HTTP response headers** — `curl -I https://auth.example.com/` shows the CSP, HSTS, and Reporting-Endpoints headers from `public/_headers`.
- **Federated login** (if configured) — clicking each provider button lands at the provider, returns to `/login/<provider>/callback`, and either creates an account, logs in, or links the identity.

## Re-deploys

A subsequent deploy is just step 7:

```sh
npm run deploy
```

Schema changes need a separate import step against the live database (CockroachDB online schema changes are non-blocking, but plan additions of NOT NULL columns carefully — see CockroachDB's online-schema-change docs). The `sql/` directory is the source of truth; diff against what's currently deployed and apply the new statements with the SQL client.

For variable changes, edit `wrangler.jsonc` and re-deploy. For secret changes, run `wrangler secret put` again and the next request picks up the new value (no redeploy needed).

## Rolling back

`wrangler deploy` keeps the previous deployment as a recoverable version. From the Cloudflare dashboard: Workers & Pages → your worker → Deployments → click a previous deployment → Rollback. The cron trigger registration follows the rollback.

Database changes can't be rolled back via Wrangler — keep additive schema changes additive, and reverse them with explicit SQL when needed. Audit-log rows are append-only and intentionally retained across deploys (subject to the tiered retention in [Operations.md → Scheduled cleanup](Operations.md#scheduled-cleanup)).
