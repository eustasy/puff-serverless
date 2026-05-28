# Operations

Tasks that need doing intermittently — not on every deploy, but as part of running Puff in production. For the codebase shape see [Architecture.md](Architecture.md); for the data model see [Hierarchy.md](Hierarchy.md); for shipping see [Deployment.md](Deployment.md).

## Table of Contents

- [Scheduled cleanup](#scheduled-cleanup)
- [Audit events & hooks](#audit-events--hooks)
  - [What gets audited](#what-gets-audited)
  - [Reading the audit log](#reading-the-audit-log)
  - [Adding a new listener](#adding-a-new-listener)
- [OAuth signing-key rotation](#oauth-signing-key-rotation)
- [Registering a new app](#registering-a-new-app)
- [Adding a federated login provider](#adding-a-federated-login-provider)
  - [GitHub](#github)
  - [Google](#google)
  - [Microsoft](#microsoft)
  - [Pushing credentials to Cloudflare](#pushing-credentials-to-cloudflare)
- [Billing operations](#billing-operations)
  - [Reading the billing audit timeline](#reading-the-billing-audit-timeline)
  - [Webhook idempotency and replay](#webhook-idempotency-and-replay)
  - [Nightly usage rollup and provider sync](#nightly-usage-rollup-and-provider-sync)
  - [Billing-contact email](#billing-contact-email)
  - [Switching payment provider](#switching-payment-provider)
  - [Known gaps and deferred work](#known-gaps-and-deferred-work)
- [Security concerns](#security-concerns)

## Scheduled cleanup

The request path only ever _soft_-expires data: sessions are marked inactive, tokens marked used, TOTP codes recorded — nothing is deleted inline. The DB itself reaps that data on a schedule.

Two different cleanup surfaces are in play, by design:

| Where                                                                                                      | Cadence              | Reaps                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CockroachDB [Row-Level TTL](https://www.cockroachlabs.com/docs/stable/row-level-ttl) (`sql/schedules.sql`) | every 5 min          | `totp_used_codes` (2 min after `used_at`), `app_floating_sessions` (at `expires_at`)                                                                      |
| CockroachDB Row-Level TTL (`sql/schedules.sql`)                                                            | hourly               | `sessions` (1 month, defunct only), `tokens` (1 month), `audit_events` (`debug`/`info` after 90 days)                                                     |
| Cloudflare Cron Trigger (`wrangler.jsonc` `triggers.crons` → `src/cron.ts`)                                | `0 0 * * *` (daily)  | `maybeRotateSigningKey(env)` — rotates weekly; see [OAuth signing-key rotation](#oauth-signing-key-rotation) below; plus the usage rollup + provider sync |
| Cloudflare Cron Trigger (`wrangler.jsonc` `triggers.crons` → `src/cron.ts`)                                | `0 * * * *` (hourly) | `reconcileBillingEmails(env)` — re-resolves each org's billing-contact email and patches the provider on drift (only when `STRIPE_SECRET_KEY` is set)     |

Row reaping (TOTP, floating-session, session, token, audit) runs **in CockroachDB itself** via Row-Level TTL — no Worker invocation, no Hyperdrive handshake per tick, no round-trip per DELETE. Work that needs Web Crypto or an external API stays in the Worker.

Each table carries a `ttl_expiration_expression` storage parameter — a per-row SQL expression yielding the row's expiry `TIMESTAMPTZ` (or `NULL` for "never") — plus a `ttl_job_cron` controlling how often CockroachDB's built-in TTL job scans it. Sessions are purged only when also defunct (inactive or past expiry): the session expression returns `NULL` for a still-valid row, so it is never deleted even if `SESSION_MAX_AGE_SECONDS` is raised beyond a month. Audit events of severity `notice` and above likewise map to `NULL` and are retained forever; only `debug` / `info` ages out after 90 days.

### Installing and observing the TTL rules

Install once per environment (idempotent — `ALTER TABLE … SET` just re-applies the same parameters):

```sh
$PSQL < sql/schedules.sql
```

Inspect at runtime:

```sql
-- One row-level-TTL schedule per TTL-enabled table.
SHOW SCHEDULES;

-- Recent TTL job runs (rowcounts, errors, timings).
WITH x AS (SHOW JOBS) SELECT * FROM x WHERE job_type = 'ROW LEVEL TTL'
ORDER BY created DESC LIMIT 20;

-- The TTL parameters currently set on a table.
SHOW CREATE TABLE sessions;
```

To pause a table's TTL job: `ALTER TABLE <table> SET (ttl_pause = true)`. To remove TTL entirely: `ALTER TABLE <table> RESET (ttl)`.

Requires CockroachDB v23.1+ (`ttl_expiration_expression`). On older versions, skip `sql/schedules.sql` and run `runScheduledCleanup(env)` from a Worker cron instead — the function in `src/cron.ts` is preserved as the manual / fallback path.

### Manual cleanup

`runScheduledCleanup(env)` is kept as a callable fallback — for development, incident-response purges, or operators on a CockroachDB version too old for Row-Level TTL. It runs all five DELETEs in one pass and logs a single summary line.

## Audit events & hooks

Account and organisation actions emit structured events through `src/hooks/`. The default listener writes a row to `audit_events`; the same dispatcher is the extension point for future listeners — webhook delivery, SIEM forwarding, real-time UI fanout — without touching the call sites.

### What gets audited

Every event is one of the named constants in `src/hooks/events.ts`. Account events (`account.*`) cover registration, login success/failure, logout, email changes, password changes and resets, 2FA setup and disable, passkey deletion, and external-identity link/unlink. Organisation events (`org.*`) cover create/update/enable/disable/delete, member add/invite/remove/role-change, invitation accept/revoke, team CRUD and team-member management, and entitlement set/remove at org/team/user grain.

Every event has a default severity (`debug` < `info` < `notice` < `warning` < `alert` < `critical`) baked into `DEFAULT_SEVERITY` in the same file. Tiering rule of thumb:

- **`info`** — routine, expected, high-volume (logins, verification resends).
- **`notice`** — meaningful state change (member added, email changed, team created).
- **`warning`** — failed attempt or suspicious action (failed login).
- **`alert`** — security-sensitive change (password change, 2FA disabled, org deleted).

Severities are codified centrally so adding a new event without assigning one is a typecheck error. Override per call site via the `event_severity` field on the emit payload when the context warrants escalation.

### Reading the audit log

`audit_events` is plain SQL. Useful queries:

```sql
-- Recent activity for a user
SELECT created_at, event_type, event_outcome, target_label, event_metadata
FROM audit_events
WHERE actor_user_uuid = '<uuid>'
ORDER BY created_at DESC
LIMIT 50;

-- Everything that's ever happened to a user (as target)
SELECT created_at, event_type, actor_user_uuid, event_metadata
FROM audit_events
WHERE target_user_uuid = '<uuid>'
ORDER BY created_at DESC;

-- Failed-login bursts in the last hour (potential brute-force)
SELECT actor_ip, COUNT(*) AS attempts, MAX(created_at) AS latest
FROM audit_events
WHERE event_type = 'account.login.failed'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY actor_ip
HAVING COUNT(*) > 10
ORDER BY attempts DESC;

-- Org-wide membership history
SELECT created_at, event_type, actor_user_uuid, target_user_uuid, event_metadata
FROM audit_events
WHERE target_org_uuid = '<org_uuid>'
  AND event_type LIKE 'org.member.%'
ORDER BY created_at DESC;
```

**Deleted referents.** The uuid columns are deliberately FK-less — an audit row exists precisely to remember an action against a specific user / org / team / app, so it must outlive the referent. Reporting code joins with `LEFT JOIN` and treats unresolved uuids as "deleted". The `target_label` column snapshots a human-readable handle (email, role name, team name) at write time, so most reports don't need the join at all.

**Retention.** Tiered by severity (`debug` / `info` reaped after 90 days, `notice` and above kept forever) — see [Scheduled cleanup](#scheduled-cleanup) above.

### Adding a new listener

The hooks dispatcher (`src/hooks/dispatch.ts`) walks a registry of listeners on every emit. Each listener declares a `kind`:

| `kind`  | When                                                                                               | Failure                                                               |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `sync`  | Awaited before the dispatcher returns. The audit listener is `sync` so the row exists on response. | Propagates — the handler's `try/catch` surfaces it (typically a 500). |
| `async` | Queued via `ctx.waitUntil`; runs after the response is sent. Best-effort.                          | Logged via `console.error`, never affects the response.               |

Two lines of work to add one:

1. Create `src/hooks/listeners/<name>.ts` exporting an object that satisfies `HookListener` (a `name`, a `kind`, an optional `filter`, and a `handle(dbClient, event)` async function).
2. Import it and append to the array in `src/hooks/registry.ts`.

A `filter: (event) => boolean` restricts which events the listener sees. A webhook listener that only cares about org membership changes might filter to `event.event_type.startsWith("org.member.")`.

Examples worth thinking about:

- **Webhook delivery**: `kind: 'async'`, reads per-org webhook URLs from a future subscription table, POSTs the event.
- **Console structured-logger**: `kind: 'async'`, wraps `console.log` with a JSON envelope so log aggregators can parse it.
- **Real-time admin dashboard**: `kind: 'async'`, pushes to a Durable Object that fans out to connected admins.

## OAuth signing-key rotation

The OAuth provider signs ID tokens and access tokens with an ES256 (ECDSA P-256) keypair. Active key material lives in the `KV_OAUTH_KEYS` KV namespace under two entries:

| KV key               | Contents                                           | Purpose                                                                  |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `oauth:keys:active`  | `{ jwk: <private JWK>, kid, created_at }`          | The current signer. New JWTs are signed with this key.                   |
| `oauth:keys:retired` | `{ jwk: <public JWK>, kid, retired_at }` (TTL 2 h) | Held during the overlap so JWTs signed by the previous key still verify. |

The matching public key is derived at runtime, exposed via `/.well-known/jwks.json`, and identified by an RFC 7638 thumbprint `kid` (deterministic from the key — no separate kid storage).

Rotation is **automatic**. A Cloudflare Cron Trigger (`0 0 * * *`) wakes the Worker once a day; `maybeRotateSigningKey(env)` (in `src/oauth-keys-rotation.ts`) checks the active key's age against `OAUTH_KEY_ROTATION_INTERVAL_DAYS` (default 7) and, if the key is older than that, mints a fresh ES256 keypair, validates it with a sign-and-verify probe, demotes the old active to retired (public half only, KV TTL = 2 hours), and writes the new active to KV. The effective cadence is therefore weekly — the daily tick just ensures rotation happens promptly without depending on exact clock timing. An audit event `oauth.signing_key.rotated` (severity `alert`) is written on success, `oauth.signing_key.rotation.failed` (severity `critical`) on failure.

### Provisioning KV

Once per environment:

```sh
npx wrangler kv namespace create KV_OAUTH_KEYS
# Paste the printed id into wrangler.jsonc → kv_namespaces[].id.
```

### First-time seed

For brand-new deployments, generate a starter keypair and seed `oauth:keys:active`:

```sh
node scripts/generate-oauth-key.mjs
# Copy the private JWK (the single-line JSON the script prints), then:
KID=$(...)   # the printed kid
JWK='<the printed private JWK>'
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "{\"jwk\": $JWK, \"kid\": \"$KID\", \"created_at\": \"$NOW\"}" \
  | npx wrangler kv key put --binding=KV_OAUTH_KEYS oauth:keys:active --pipe
```

Alternatively, push the same private JWK as the legacy `OAUTH_SIGNING_KEY_PRIVATE` secret — the runtime path falls back to it when KV is empty, and the next rotation tick copies it into KV automatically. This is the gentler path for migrating an existing deployment.

For local development, set the JWK in `.env` as `OAUTH_SIGNING_KEY_PRIVATE` (no KV binding needed locally).

### Operator endpoints

Both gated by the `OPERATOR_USER_UUIDS` env var (comma- or whitespace-separated list of UUIDs allowed to call admin endpoints). Both POST-only.

| Endpoint                                             | Effect                                                                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/db/auth/admin/oauth-keys/rotate`          | Rotate now, ignoring the age check. Useful for staging rehearsals or responding to a suspected compromise.                                                                                                     |
| `POST /api/db/auth/admin/oauth-keys/promote-retired` | Emergency rollback. Swaps `oauth:keys:retired` back into `oauth:keys:active`. Only works while the retired entry carries the private scalar `d` — the normal rotation strips it, so this is a last-ditch path. |

Both write an audit event (`oauth.signing_key.rotated` / `oauth.signing_key.retired.promoted`).

### What gets exposed

`/.well-known/jwks.json` exposes the active public JWK and, while the retired KV entry is held, the retired one alongside it. Clients fetching JWKS will validate JWTs against both during the overlap window. Browsers and JWT libraries fetch JWKS lazily and cache the response; the `Cache-Control: public, max-age=60` on the endpoint matches the KV-read cache inside the Worker, so the overall propagation lag for a rotation is bounded by `max(KV propagation ~60s, JWKS Cache-Control 60s)`.

## Registering a new app

"App" here means an OAuth client — a downstream service that logs its users in with Puff. Until the operator UI lands (Phase 7 follow-up), registration is direct DB access. Apps are **globally registered**, not org-owned — any org can grant its users entitlements for any registered app (see [Hierarchy.md → Apps & licensing](Hierarchy.md#apps--licensing)).

1. **Pick a client_id.** It must be unique across all apps. Convention: a short, hostname-like identifier (e.g. `my-app`).
2. **Generate a client_secret.** Any high-entropy random string is fine — 32+ bytes base64-encoded works. Save the plaintext; you'll hand it to the app's operator and never see it again (Puff stores only the hash).
3. **Hash the secret** using Puff's hashing module:

   ```sh
   # From a Node REPL in the repo root:
   node --input-type=module -e "
     import('./src/utilities/hashing.js').then(async ({ puff_hashing_password, PREFERRED_PASSWORD_ALGO }) => {
       const hash = await puff_hashing_password('<the plaintext secret>')
       console.log(hash)
     })
   "
   ```

   The output is the hash string to store. **Don't store the plaintext anywhere.**

4. **Insert the row.** All apps must declare a licensing mode at registration — one of `'none'`, `'seat'`, `'usage'`, `'floating'`. See [Hierarchy.md → Apps & licensing](Hierarchy.md#apps--licensing) for what each mode means.

   ```sql
   INSERT INTO apps (
     app_uuid, app_name, client_id, client_secret,
     redirect_uris, app_active, app_licensing_mode
   )
   VALUES (
     gen_random_uuid(),
     'My App',
     'my-app',
     '<the hash from step 3>',
     ARRAY['https://my-app.example.com/oauth/callback'],
     TRUE,
     'none'
   )
   RETURNING app_uuid;
   ```

5. **(For `seat` / `floating` modes only)** Seed the app's self-owned defaults — the tiers it offers, the perms it declares, the default floating-pool size. These live in `app_key_values` as `(subject = app, owner = app, key = …)`:

   ```sql
   INSERT INTO app_key_values (app_uuid, owner_app_uuid, kv_key, kv_value)
   VALUES
     ('<app_uuid>', '<app_uuid>', 'license:tiers:basic', 'Basic'),
     ('<app_uuid>', '<app_uuid>', 'license:tiers:pro', 'Pro'),
     ('<app_uuid>', '<app_uuid>', 'license:perms:read', 'Read access'),
     ('<app_uuid>', '<app_uuid>', 'license:perms:write', 'Write access'),
     ('<app_uuid>', '<app_uuid>', 'license:floating:max', '10');
   ```

6. **Hand the credentials to the app's operator** — `client_id` (public) + `client_secret` (the plaintext from step 2, **once**).

Org admins can now grant entitlements for the app under `functions/api/db/auth/organisations/[org_uuid]/apps/[app_uuid]/...`, gated by `org:entitlements:write`. The app authenticates against `/oauth/token` with HTTP Basic or body params and uses the standard OAuth 2.1 Authorization Code + PKCE flow ([Architecture.md → OAuth 2.1 / OIDC endpoints](Architecture.md#oauth-21--oidc-endpoints-puff-as-provider)).

To disable an app, set `app_active = FALSE`. The change is reversible and doesn't cascade — existing grants stay in place but new authorization requests are rejected.

## Adding a federated login provider

The provider buttons on `public/login.html` and `public/account.html` are HTMX-loaded from `/api/providers` — a no-DB, no-auth endpoint that calls `listConfiguredProviders(env)` and returns buttons only for providers with both `OAUTH_<PROVIDER>_CLIENT_ID` and `OAUTH_<PROVIDER>_CLIENT_SECRET` set. An unconfigured provider does not appear; an empty response (zero providers) collapses the section entirely.

To enable one, three things have to line up: an app registration at the provider, a pair of secrets pushed to Cloudflare, and the schema imported into the database (the federated-login tables are already imported in the production deploy — see [Deployment.md → Provision the database](Deployment.md#1-provision-the-database)).

**Redirect URI** — every provider needs the exact callback URL Puff will return to, derived from `APP_URL`:

```
${APP_URL}/login/<provider>/callback
```

Localhost and production are separate registrations (the URI must match exactly), so register a "dev" app pointing at `http://localhost:8788/login/<provider>/callback` and a separate "prod" app pointing at your deployed URL.

### GitHub

1. **Register the OAuth App** — [Settings → Developer settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   - **Application name**: anything (shown to users on the consent screen).
   - **Homepage URL**: your `APP_URL`.
   - **Authorization callback URL**: `${APP_URL}/login/github/callback`.
2. **Generate a client secret** — on the app's page, _Generate a new client secret_. Copy it once; GitHub never shows it again.
3. **Note the Client ID** — shown on the same page.
4. Scopes are requested at authorize-time (`read:user user:email`) — no per-app scope configuration on GitHub's side.

### Google

1. **Configure the OAuth consent screen** first — Google requires it before any credential will work. [Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent). Set User Type to External (or Internal for a Workspace tenant), fill in the app name + support email, and add the `openid`, `email`, and `profile` scopes.
2. **Create an OAuth 2.0 Client ID** — [Credentials → Create Credentials → OAuth client ID](https://console.cloud.google.com/apis/credentials). Application type: **Web application**.
   - **Authorised redirect URIs**: `${APP_URL}/login/google/callback`.
3. **Copy the Client ID + Client Secret** from the credential's details page.
4. While the consent screen is in Testing mode, only the test users you list can sign in; submit it for verification before going public.

### Microsoft

1. **Register the application** — [Azure Portal → App registrations → New registration](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade).
   - **Supported account types**: _Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)_ — this is what matches the `https://login.microsoftonline.com/common/...` endpoints Puff uses.
   - **Redirect URI**: platform **Web**, URI `${APP_URL}/login/microsoft/callback`.
2. **Generate a client secret** — _Certificates & secrets → Client secrets → New client secret_. Copy the **Value** (not the Secret ID) immediately; Azure hides it on the next page load.
3. **Copy the Application (client) ID** — shown on the Overview page.
4. **API permissions** — Microsoft Graph → Delegated → add `openid`, `email`, `profile` (already present by default for a fresh registration; verify they are there).

Microsoft's `/oidc/userinfo` endpoint deliberately omits the OIDC `email_verified` claim, so Puff reads the `tid` (tenant ID) out of the ID token returned by `/token` instead. A `tid` other than the special personal-MSA tenant (`9188040d-6c67-4c5b-b112-36a304b66dad`) means a work/school tenant where the email is the verified UPN — trusted as `email_verified: true`. Personal MSA accounts (Outlook / Hotmail / Xbox), and any unparseable or missing ID token, stay unverified and land in Puff's standard verification flow.

### Pushing credentials to Cloudflare

For each provider you registered, push the two values as Worker secrets:

```sh
echo "<the client id>"     | npx wrangler secret put OAUTH_GITHUB_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GITHUB_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_GOOGLE_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_SECRET
```

For local development, put the same values in `.env` (git-ignored). A provider where **either** of its env vars is missing is treated as not configured and its `/login/<provider>` route 404s.

## Billing operations

### Reading the billing audit timeline

All billing state changes emit events through the standard audit log (`audit_events`). The full set of `billing.*` event types and their default severities:

| Event type                      | Default severity | When emitted                                                                            |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `billing.customer.created`      | `notice`         | `ensureCustomer` creates a new Stripe customer.                                         |
| `billing.subscription.created`  | `notice`         | Webhook `customer.subscription.created`.                                                |
| `billing.subscription.updated`  | `notice`         | Webhook `customer.subscription.updated` (tier change, period renewal, status sync).     |
| `billing.subscription.paused`   | `notice`         | Webhook `customer.subscription.updated` with `status = "paused"`.                       |
| `billing.subscription.resumed`  | `notice`         | Webhook `customer.subscription.updated` when recovering from `paused`.                  |
| `billing.subscription.canceled` | **`alert`**      | Webhook `customer.subscription.deleted`. Investigate if unexpected.                     |
| `billing.invoice.issued`        | `notice`         | Webhook `invoice.finalized`.                                                            |
| `billing.invoice.paid`          | `notice`         | Webhook `invoice.paid`.                                                                 |
| `billing.invoice.voided`        | `notice`         | Webhook `invoice.voided`.                                                               |
| `billing.payment.succeeded`     | `notice`         | Webhook `invoice.payment_succeeded`.                                                    |
| `billing.payment.failed`        | **`warning`**    | Webhook `invoice.payment_failed`. Access is cut off immediately — no grace window.      |
| `billing.usage.recorded`        | `debug`          | App posts a usage event to `POST /api/billing/usage/[app_uuid]`. High-volume; ages out. |

Useful queries:

```sql
-- All billing events for an org, newest first
SELECT created_at, event_type, event_metadata
FROM audit_events
WHERE target_org_uuid = '<org_uuid>'
  AND event_type LIKE 'billing.%'
ORDER BY created_at DESC;

-- Recent payment failures across all orgs (potential dunning candidates)
SELECT created_at, target_org_uuid, target_app_uuid, event_metadata
FROM audit_events
WHERE event_type = 'billing.payment.failed'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;

-- Subscription cancellations in the last 30 days (churn)
SELECT created_at, target_org_uuid, target_app_uuid, event_metadata
FROM audit_events
WHERE event_type = 'billing.subscription.canceled'
  AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```

`billing.payment.failed` flips `isLicensed` to `false` immediately (the `subscriptions.status` is updated to `past_due` by the preceding `customer.subscription.updated` webhook). There is no grace window and no automatic dunning — see [Known gaps and deferred work](#known-gaps-and-deferred-work).

**Refunds** are handled manually in the Stripe Dashboard (Billing → Invoices → find the invoice → Refund). A refunded invoice does not retroactively revoke entitlements — the subscription status drives access, not the invoice status. After issuing a refund you may separately cancel the subscription if warranted.

### Webhook idempotency and replay

`POST /api/billing/webhook` verifies the Stripe `stripe-signature` header (WebCrypto HMAC-SHA256, constant-time comparison) before doing any DB work. Stripe retries a failed delivery for up to three days with the same event `id`.

Replay safety is enforced by the `billing_webhook_events` table: each event is recorded once under the composite PK `(provider, provider_event_id)`. The dedup `INSERT … ON CONFLICT DO NOTHING` and the state-change query run inside one transaction. A replay sees `rowCount = 0` on the dedup insert, rolls back via a `Rollback` sentinel, and returns 200 to stop further retries. A processing failure also rolls back the dedup row so the provider's next retry is honoured rather than silently dropped.

To inspect recent webhook activity:

```sql
SELECT received_at, event_type, provider_event_id
FROM billing_webhook_events
WHERE provider = 'stripe'
ORDER BY received_at DESC
LIMIT 50;
```

If you need to force-replay an event (e.g. after a bug fix), delete its row from `billing_webhook_events` first:

```sql
DELETE FROM billing_webhook_events
WHERE provider = 'stripe' AND provider_event_id = 'evt_…';
```

Then trigger a manual retry in the Stripe Dashboard (Developers → Webhooks → select endpoint → find the event → Resend).

### Nightly usage rollup and provider sync

The daily Cron Trigger (`0 0 * * *`) runs the following in order:

1. `maybeRotateSigningKey` — OAuth key rotation (existing; see [OAuth signing-key rotation](#oauth-signing-key-rotation)).
2. `recomputeUsageRollups(yesterday)` — aggregates `usage_events` for the previous full UTC day into `usage_rollups`, grouped by `(app_uuid, org_uuid, metric, day)`. Fully idempotent: re-running overwrites the quantity and clears `synced_at` only when the quantity changed.
3. `recomputeUsageRollups(today)` — same for the current in-progress UTC day, so intra-day queries reflect recent events.
4. `syncUsageRollups` — pushes unsynced rollups (where `synced_at IS NULL`) to Stripe as Billing Meter events (`POST /v1/billing/meter_events`). The `metric` string becomes the `event_name`; a per-`(app, org, metric, day)` `identifier` prevents double-billing on retry. Sets `synced_at = now()` on success; leaves failures unsynced for the next run. Only executes when `STRIPE_SECRET_KEY` is configured.

To check for unsynced rollups manually:

```sql
SELECT app_uuid, org_uuid, metric, day, quantity
FROM usage_rollups
WHERE synced_at IS NULL
ORDER BY day ASC;
```

### Billing-contact email

The email on each Stripe customer (where Stripe sends receipts and its own failed-payment dunning) is **resolved automatically**, never typed per subscription:

`effective = billing_customers.billing_email (operator override) ?? resolveBillingEmail(org)`

`resolveBillingEmail` picks the highest-ranked org member who has a **verified primary email**, in order:

1. a member whose only role is `billing` (the dedicated finance contact)
2. `billing` + `owner`
3. `billing` + `admin`
4. any `billing`-role member
5. an `owner` (final fallback, even without the billing role)

Tiebreak: earliest membership, then email. If nobody qualifies and no override is set, the customer is created with no email (Stripe then has no one to notify).

- **Set / clear the override:** `POST /api/db/auth/organisations/[org_uuid]/billing/email` (form field `email`; empty clears it), requires `org:billing:write`. This re-resolves and pushes to Stripe immediately.
- **Drift:** the hourly cron (`reconcileBillingEmails`) re-resolves every customer and patches Stripe only when the effective address differs from the stored `billing_customers.synced_email` — so a membership change or an email re-verification propagates within an hour without touching the membership endpoints.
- **Multiple recipients:** Stripe's customer holds a single email. To notify several billing-role members, point the override at a distribution alias the org maintains (Puff does not multicast on Stripe's behalf).

### Switching payment provider

The billing domain layer (`src/billing.ts`) is provider-agnostic. The `BillingProvider` interface defines all payment-rail operations; `createStripeProvider(env)` in `src/billing-stripe.ts` is the only Stripe-specific code. To switch providers:

1. Write a new adapter implementing `BillingProvider` (throws on error; the domain layer maps throws to 502 envelopes).
2. Replace calls to `createStripeProvider(env)` in the endpoint files with calls to your new factory.
3. Update the webhook endpoint (`functions/api/billing/webhook.ts`) to verify the new provider's signature scheme and call the appropriate handler.
4. Migrate `billing_customers.provider` / `subscriptions.provider` / `invoices.provider` / `billing_webhook_events.provider` rows if you need historical data to remain queryable under the new provider name.

The schema's `provider` column is a plain `TEXT` field — it stores `"stripe"` today but is not constrained to that value.

### Known gaps and deferred work

Operators should be aware of the following limitations that are not yet implemented:

- **Puff-originated dunning emails.** Puff does not send its own emails to `billing`-role members on payment failure or upcoming renewal. Stripe's built-in dunning does reach the resolved customer email (see [Billing-contact email](#billing-contact-email)), and access is cut off immediately on failure; a Puff-side mailer that notifies all billing-role members is deferred.
- **Operator endpoints.** Read-only dashboards exist — `GET /api/db/auth/admin/billing/subscriptions` (all subscriptions across orgs) and `GET /api/db/auth/admin/billing/usage` (rollups, optional `?org_uuid=`), behind the `OPERATOR_USER_UUIDS` gate. **Comp seats** are handled with a Stripe 100%-off coupon (Puff sees a normal `active` subscription — no special status); **manual invoices** are raised in the Stripe Dashboard and flow into Puff via the webhook's customer fallback. Neither needs a Puff write endpoint.
- **Refund automation.** Refunds are manual via the Stripe Dashboard. Issuing a refund does not automatically adjust entitlements — subscription cancellation is a separate step.

## Security concerns

Operational guardrails worth keeping in mind:

- **Cookie security** — `SECURE_COOKIE=true` and `COOKIE_SAMESITE=Lax` are the production defaults. The cross-origin write guard in `functions/api/db/_middleware.ts` rejects same-site CSRF from sibling subdomains independently of `SameSite`. If you serve Puff alongside other apps on the same parent domain, the guard is what closes the residual gap.
- **Password policy** — at minimum, enforce `MIN_PASSWORD_LENGTH ≥ 12` and turn on `REQUIRE_NOT_COMPROMISED` (HIBP). `REQUIRE_ZXCVBN` is the strongest single setting — score ≥ 3 catches most weak passwords without requiring arbitrary character-class flags.
- **2FA bypass** — the `/api/db/2fa/bypass/request` flow sends a single-use email link to a verified address on the account: the primary if it's verified, otherwise the oldest-verified secondary. Possession of that inbox is the second factor; if an attacker compromises a user's email and their password, 2FA does not save them. The endpoint also refuses to send if a password reset was completed in the last 24 hours — otherwise email alone could reset the password (factor 1) and then bypass 2FA (factor 2). Encourage passkeys (which bind to the device and aren't email-recoverable) for high-value accounts.
- **TOTP replay** — handled by `totp_used_codes` and the 5-minute DB schedule. A code is accepted at most once within its 30s validity window; replays within the same window are rejected.
- **OAuth signing key** — the active key lives in `KV_OAUTH_KEYS`; a daily cron rotates it automatically once a week (default `OAUTH_KEY_ROTATION_INTERVAL_DAYS=7`). The retired key is held in JWKS for a two-hour overlap so in-flight tokens validate through the transition. Trigger an on-demand rotation via `POST /api/db/auth/admin/oauth-keys/rotate` after any suspected compromise.
- **Audit log** — `notice` and above are retained indefinitely. Use it for incident investigation; the `target_label` column snapshots referents that may later be deleted. Don't store sensitive payloads in `event_metadata` (passwords, full tokens) — it ends up in the audit table verbatim.
- **CSP violation reporting** — `public/_headers` declares a `report-uri` and `Reporting-Endpoints`; violations land at `functions/api/csp-report.ts`, which logs them via `console.warn`. Check `wrangler tail` periodically (or pipe it to a log aggregator) to spot misconfigurations or attacks.
- **Schema changes** — keep additive. The audit table outlives its referents because the FK constraints were deliberately omitted; any schema change that adds FKs to existing append-only data should be reviewed carefully.
