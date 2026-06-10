# Architecture

How the codebase is laid out, how a request flows through it, and the runtime pieces it depends on. For local-dev setup see [Development.md](Development.md); for shipping it see [Deployment.md](Deployment.md); for the data model and entity relationships see [Hierarchy.md](Hierarchy.md); for cron, audit, and operator tasks see [Operations.md](Operations.md).

## Table of Contents

- [Build model](#build-model)
- [Request layering](#request-layering)
- [`src/` domain modules](#src-domain-modules)
- [Directories](#directories)
- [Special files](#special-files)
- [Libraries](#libraries)
- [External APIs](#external-apis)
  - [Cached lookups](#cached-lookups)
  - [Outbound email](#outbound-email)
  - [Synchronous external calls](#synchronous-external-calls)
  - [Don't use queues](#dont-use-queues)
- [OAuth 2.1 / OIDC endpoints (Puff as provider)](#oauth-21--oidc-endpoints-puff-as-provider)
- [Federated login (Puff as client)](#federated-login-puff-as-client)
- [Billing (Phase 9)](#billing-phase-9)
- [Environment variables](#environment-variables)

## Build model

The project deploys as a **single Cloudflare Worker bundle**, but is authored with **Pages Functions** directory-routing conventions. The build step (`wrangler pages functions build`) is the Pages compiler; the deploy step (`wrangler deploy`) is the Workers path. `public/` is served as Workers Static Assets; `functions/` is compiled into the same bundle. `dist/worker/` is a build artifact — never edit it.

`wrangler.jsonc`'s `main` is **`worker.ts`**, not the compiled bundle. The Pages compiler emits only a `fetch` handler; `worker.ts` is a thin entry that forwards `fetch` to the compiled `dist/worker/index.js` and adds the `scheduled` handler (Cron Triggers — see `src/cron.ts`). `worker.ts` sits outside the `tsconfig.json` `include` globs on purpose, because it imports the post-build artifact.

Node built-ins are marked `--external` in the build script (see `package.json`); `nodejs_compat` provides them at runtime. `compatibility_date` lives in both `wrangler.jsonc` and the build script.

Stack: Cloudflare Workers + Pages Functions, CockroachDB (Postgres-compatible) via Cloudflare Hyperdrive, `pg` client, `otplib` for TOTP, `@simplewebauthn/server` for passkeys, `zxcvbn` for password strength. The frontend is static HTML driven entirely by HTMX — there is no custom client-side JS, and **API endpoints return HTML fragments, not JSON**.

## Request layering

API endpoints live at **flat paths** under `functions/api/` (e.g. `functions/api/email/list.ts`, `functions/api/user/login.ts`). Tier is **not** encoded in the directory path. A single `functions/api/_middleware.ts` cascades to every `/api/*` request and composes the shared tier functions from `src/utilities/`, selecting them per request via a **route-policy table** (`policyFor`). The composed chain is an ordered array:

```ts
export const onRequest = [corsGate, maybeDb, maybeAuth, maybeOperator]
```

Each gate either runs its tier function or passes straight through (`context.next()`), based on the `Policy` resolved for the request path:

| Gate | Tier function (in `src/utilities/`) | Adds to `context.data` / effect |
| --- | --- | --- |
| `corsGate` | `sameOriginWriteGuard` _or_ `externalCorsGuard` | cross-origin enforcement (always runs; guard chosen by `cors` field) |
| `maybeDb` | `createDbMiddleware("/api")` | `dbClient` (Hyperdrive `pg`) |
| `maybeAuth` | `sessionAuthMiddleware` | `user_uuid` (from `session_token` cookie) |
| `maybeOperator` | `operatorAuthMiddleware` | operator-UUID gate for `/api/admin/*` |

`createDbMiddleware`'s `try/finally` wraps `context.next()`, so when `maybeDb` runs the DB tier its connection stays open through `maybeAuth` + `maybeOperator` + the route handler and is closed afterwards — the same lifecycle the old nested tree gave.

### The route-policy table

`policyFor(pathname)` returns `{ db, auth, operator, cors }`. It is **fail-safe**: the default for any `/api/*` path **not** matched below is `{ db: true, auth: true }` — the most-protected tier. A new endpoint someone forgets to register is therefore locked down, not exposed.

- **`NO_DB`** (exact-path `Set`) — neither DB nor session (e.g. `/api/providers`, `/api/password-requirements`, `/api/messages`, `/api/csp-report`).
- **`PUBLIC_DB`** (exact-path `Set`) — DB but no session: login, registration, and token-capability flows (e.g. `/api/user/login`, `/api/password/request`, `/api/email/verify`, `/api/2fa/login`, `/api/organisations/invitation/view`, `/api/federated-signup/confirm`). Exact paths only — a prefix would be too greedy (e.g. `/api/organisations/create` must stay auth-required).
- **`/api/billing/` prefix** — DB but no session, and `cors: "external"`. These are token/signature-authed _inside the handler_ (Stripe webhook + the dynamic `usage/[app_uuid]` API), so they need a prefix (the dynamic segment defeats an exact `Set` entry) and the external CORS guard rather than the same-origin block.
- **`/api/admin/` prefix** — `{ db: true, auth: true, operator: true }`. The one stricter opt-in.

Because `auth` implies `db` and `operator` implies `auth` in `policyFor`, the gates never run a tier whose prerequisite was skipped (e.g. `sessionAuthMiddleware` always finds `context.data.dbClient`).

### Internal vs external CORS

`corsGate` always runs and picks the guard by the policy's `cors` field:

- **`sameOriginWriteGuard`** (internal, the default) — first-party HTMX endpoints authenticated by the ambient `session_token` cookie. State-changing requests (non-GET/HEAD/OPTIONS) whose `Sec-Fetch-Site` is not `same-origin` (falling back to an `Origin` match when `Sec-Fetch-*` is absent) are rejected with a 403. This is a _block_, not CORS proper — it adds no `Access-Control-*` headers. It stops same-site CSRF from sibling subdomains that `SameSite=Lax` does not catch.
- **`externalCorsGuard`** (external, opt-in for `/api/billing/*`) — third-party callers authenticated by a Stripe signature or app token _inside the handler_, never by the session cookie. With no ambient credential there is no CSRF vector, so it never blocks on origin: it answers the `OPTIONS` preflight (204) and echoes an allowlisted `Origin` (from `EXTERNAL_CORS_ORIGINS`) onto the response.

The default is the strict internal guard, so a new endpoint is CSRF-protected unless it is deliberately opted into the external tier.

### Resource-scoped middleware (not part of the tier model)

Beneath `organisations/[org_uuid]/` (and nested `apps/[app_uuid]/`, `teams/[team_uuid]/`), three `_middleware.ts` files resolve the caller's role set into `context.data.orgRoles` / `context.data.teamRoles` (and the resolved app row into `context.data.app`). These are **resource-scoped authz**, distinct from the db/auth/operator tiers: they run _after_ the policy middleware, on the path that owns the resource, and relocate intact with their subtree. They are not selected by the policy table.

Endpoints read `context.data.dbClient` / `context.data.user_uuid` (etc.) directly — never re-connect or re-authenticate in a handler.

## `src/` domain modules

`src/` holds backend logic with no HTTP handling, one module per domain (`users`, `sessions`, `passwords`, `emails`, `tokens`, `2fa`, `passkeys`, `organisations`, `teams`, `memberships`, `invitations`, `apps`, `oauth-*`, `external-identities`, `hooks`, plus `src/utilities/`). Every `src/` function takes `dbClient` as its first parameter and returns a structured envelope:

```ts
type Envelope<T> =
  | ({ success: true; status: number } & T) // ran successfully
  | { success: false; message: string; status: number } // validation / business-rule failure
  | { error: true; message: string; details?: unknown; status: number } // DB / system error
```

They do not throw or return raw rows. The sole exception is `registerUser`, which throws (wrap calls in try/catch).

`src/cron.ts` is a deliberate departure: it runs on a Cron Trigger with no `_middleware.ts` in front of it. It handles work that has to stay in the Worker, dispatching on the matched cron expression: the daily tick (`0 0 * * *`) does OAuth signing-key rotation (`src/oauth-keys-rotation.ts`, rotating weekly) and the usage rollup + provider sync; the hourly tick (`0 * * * *`) reconciles each org's billing-contact email to the provider. Pure-SQL row reaping lives in the database itself via `sql/schedules.sql`. The retained `runScheduledCleanup` helper is for manual / fallback use and opens its own short-lived `pg` client. See [Operations.md → Scheduled cleanup](Operations.md#scheduled-cleanup).

`src/hooks/` is the extensibility point — every account/org mutation emits a structured event through it. The default listener writes to the `audit_events` table; future listeners (webhooks, SIEM forwarding) plug into the same registry. See [Operations.md → Audit events & hooks](Operations.md#audit-events--hooks).

## Directories

| Folder | Contents | Role |
| --- | --- | --- |
| `public/` | Static files: HTML pages, CSS, the bundled HTMX client. | Workers Static Assets |
| `functions/` | Pages-Function-routed endpoints (TypeScript), including HTML page renderers. | Bundled into Worker |
| `functions/api/` | Flat-path API endpoints; tier (DB / auth / operator) is set per request by the `functions/api/_middleware.ts` policy table, not by directory depth. | Bundled into Worker |
| `src/` | Backend logic by domain (`users.ts`, `sessions.ts`, `oauth-*.ts`, `hooks/`, …) | Bundled into Worker |
| `src/utilities/` | Shared helpers (`hashing.ts`, `headers.ts`, `responses.ts`, `transaction.ts`, …) | Bundled into Worker |
| `sql/` | One `.sql` file per table — schema source of truth. | Reference (imported manually) |
| `test/` | Vitest unit tests, one `*.test.ts` per `src/` module. | Not deployed |
| `scripts/` | One-shot operator scripts (e.g. `generate-oauth-key.mjs`). | Not deployed |
| `docs/` | Human-facing documentation (this directory). | Not deployed |
| `.github/instructions/` | AI-tooling guidance (architecture/backend/database/frontend/security). | Not deployed |
| `dist/worker/` | Build output from `wrangler pages functions build`. Never edit. | Build artifact |

## Special files

| File | Role |
| --- | --- |
| `worker.ts` | Worker entry (`wrangler.jsonc`'s `main`). Forwards `fetch` to the built bundle; exports `scheduled`. |
| `wrangler.jsonc` | Wrangler config: bindings (`HYPERDRIVE`, `ASSETS`), `vars`, `triggers.crons`, custom-domain routes. |
| `public/_headers` | HTTP response headers ([Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)) including CSP, HSTS, and the reporting endpoint. |
| `public/_redirects` | Redirect rules ([Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)). |
| `functions/_middleware.ts` | Root middleware: page-level cookie gating for the static HTML files. |
| `functions/api/_middleware.ts` | The single API middleware. Composes `[corsGate, maybeDb, maybeAuth, maybeOperator]` from `src/utilities/` and selects each tier per request via the `policyFor` route-policy table (fail-safe default db+auth). |
| `types.d.ts` | Ambient global types (`DbClient`, `Env`, `RequestData`, `Handler`, `Envelope`, row interfaces). |
| `env.d.ts` | Cloudflare Pages Functions Env declaration that augments `types.d.ts`'s `Env`. |
| `worker-configuration.d.ts` | Auto-generated by `npx wrangler types`. Don't edit by hand. |

## Libraries

| Library                  | Type           | Purpose                                                            |
| ------------------------ | -------------- | ------------------------------------------------------------------ |
| HTMX                     | Client-side JS | The frontend — every interactive form swaps an HTML fragment.      |
| `pg`                     | Server-side    | PostgreSQL client; the `DbClient` global type aliases `pg.Client`. |
| `otplib`                 | Server-side    | TOTP (RFC 6238) generation and verification for 2FA.               |
| `uqr`                    | Server-side    | Inline-SVG QR code rendering for the 2FA setup screen.             |
| `@simplewebauthn/server` | Server-side    | WebAuthn / passkey registration and authentication verification.   |
| `zxcvbn`                 | Server-side    | Password strength estimation (Dropbox's library).                  |
| Vitest                   | Dev / test     | Unit-test runner.                                                  |
| Prettier                 | Dev / test     | Code formatter; `npm run lint` checks it.                          |

Versions are pinned in `package.json` and updated by Dependabot.

## External APIs

| API                                                         | Purpose                                                                                                                               | Calling pattern                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Have I Been Pwned — Pwned Passwords (k-anonymity range API) | Reject breached passwords when `REQUIRE_NOT_COMPROMISED` is on. The password never leaves the server (only the SHA-1 prefix is sent). | Cached (`cf.cacheTtl`, 24h). See [Cached lookups](#cached-lookups).                   |
| Mailtrap Send API                                           | Outbound email (verification, password reset, invitations, 2FA bypass, federated-signup verify).                                      | Mixed — see [Outbound email](#outbound-email).                                        |
| GitHub / Google / Microsoft OAuth + userinfo endpoints      | Federated sign-in. Per-provider config in `src/oauth-providers.ts`.                                                                   | Synchronous (`await`). See [Synchronous external calls](#synchronous-external-calls). |

Outbound `fetch()` from the Worker follows one of three patterns. The choice is determined by whether the response shapes the user-facing reply.

### Cached lookups

Pass `cf.cacheTtl` so Cloudflare's per-colo HTTP cache memoises the response. Cache key is the URL; pick a TTL based on how fresh the data needs to be:

```ts
const response = await fetch(externalUrl, {
  cf: { cacheTtl: 86400, cacheEverything: true },
})
```

**Canonical example.** `hibpBreachCount` in `src/passwords.ts` uses a 24-hour TTL. The HIBP k-anonymity dataset only updates when new breaches are processed, so 24h is comfortably under the data's effective freshness. The cache key is the SHA-1 prefix (the URL path); multiple users testing passwords that share the same 5-char prefix all benefit from one upstream fetch per colo per day. The same caching also retroactively makes the `passwordRequirements` / `passwordRequirementsHtml` pair's repeated HIBP check on the failure path near-free.

### Outbound email

`src/mailer.ts` wraps the Mailtrap Send API. Most call sites use **fire-and-forget via `context.waitUntil`** so the response is sent immediately and the email continues delivering in the background. The Worker isolate stays alive until the promise settles; without `waitUntil` the runtime may kill the isolate the moment the response is committed:

```ts
context.waitUntil(
  sendVerificationEmail(context.env, email, token).then((mailResult) => {
    if (mailResult.error) {
      console.error("Failed to send verification email:", mailResult.message)
    }
  })
)

return resultPositive("Done.", 200)
```

| Email                                                                           | Pattern     | Why                                                                                                                                       |
| ------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Password-reset (`functions/api/password/request.ts`)                            | `waitUntil` | Response is intentionally generic ("if an account exists, a link has been sent") regardless of delivery outcome — enumeration prevention. |
| 2FA-bypass (`functions/api/2fa/bypass/request.ts`)                              | `waitUntil` | Same generic-response pattern.                                                                                                            |
| Federated-signup verify (`functions/api/federated-signup/confirm.ts`)           | `waitUntil` | Best-effort; the user is being redirected into their session regardless.                                                                  |
| Verification-resend (`functions/api/email/resend.ts`)                           | `await`     | The user explicitly asked to resend, so a delivery failure is reported back inline (502).                                                 |
| Invitation (`functions/api/organisations/[org_uuid]/members/invite.ts`)         | `await`     | The handler intentionally returns 502 on send failure so the operator who issued the invitation knows.                                    |

Failures in `waitUntil` paths are logged via `console.error`; there is no automatic retry. Users can resend (verification) or re-request (password reset) via the same flows. This is deliberately simpler than introducing a retry queue — the user-driven resend flows are the retry mechanism.

### Synchronous external calls

Plain `await` for fetches whose result shapes the response. The handler can branch on success/failure and return a tailored response.

| Site                                                                   | API                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `functions/login/[provider]/callback.ts` (via `src/oauth-outbound.ts`) | Provider `/token` and userinfo endpoints — must complete before issuing the Puff session. |
| Verification-resend and invitation emails (see above)                  | Mailtrap — failures surface inline.                                                       |

### Don't use queues

Cloudflare Queues are for asynchronous **work delivery**, not for caching or fire-and-forget. For Puff's current volume, `context.waitUntil` + `cf.cacheTtl` cover every case. Re-evaluate only if a real volume, rate-limit, or retry requirement emerges (e.g. bulk announcement emails, or Mailtrap rate-limiting hits).

## OAuth 2.1 / OIDC endpoints (Puff as provider)

Puff is itself an OAuth 2.1 / OpenID Connect provider. Registered apps log their users in with Puff via the Authorization Code flow with PKCE. **Confidential clients only** — every app has a `client_secret` and authenticates on `/oauth/token` via HTTP Basic (`client_secret_basic`) or body params (`client_secret_post`). PKCE is required on every code exchange regardless (OAuth 2.1, `S256` only).

| Endpoint                            | Method       | Purpose                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/oauth/authorize`                  | `GET`/`POST` | Validates client + redirect_uri + PKCE, redirects to `/login` when no session, renders a consent screen when `oauth_consents` doesn't already cover the requested scopes, then redirects back with `?code=`.                               |
| `/oauth/token`                      | `POST`       | Exchanges `grant_type=authorization_code` (consumed atomically, PKCE verified) for `access_token` + `id_token` (when `openid` was granted) + `refresh_token` (when `offline_access` was granted). Also rotates `grant_type=refresh_token`. |
| `/oauth/userinfo`                   | `GET`        | Bearer-authenticated OIDC claim response: `{ sub, name?, email?, email_verified? }` depending on which scopes were granted.                                                                                                                |
| `/.well-known/openid-configuration` | `GET`        | OIDC Discovery document.                                                                                                                                                                                                                   |
| `/.well-known/jwks.json`            | `GET`        | JWKS — the active public signing key, plus the retired one during a rotation overlap window.                                                                                                                                               |

Lifetimes: authorization code 5 min, access token + ID token 1 hour, refresh token 30 days. Access tokens are stateless `ES256` JWTs; only authorization codes and refresh tokens persist in `oauth_grants`. Remembered consent is per-`(user, app)` in `oauth_consents`.

**Scopes.** Standard OIDC: `openid`, `profile`, `email`, `offline_access` (triggers refresh-token issuance). Puff-specific: `puff:memberships` (the user's orgs), `puff:roles` (their org + team role assignments), `puff:entitlements` (entitlement claim resolved against the org context the grant was bound to).

**Org context.** Requests can carry `org_uuid` on `/authorize` to pick which org the user is acting through. With zero candidates → `access_denied`; one → auto-bound; multiple → the consent screen renders an org picker. The chosen `org_uuid` persists on `oauth_grants`, propagates onto rotated refresh tokens, and is baked into the access-token JWT.

Domain modules: `src/apps.ts`, `src/oauth-grants.ts`, `src/oauth-consents.ts`, `src/oauth.ts` (shared helpers), `src/oauth-jwt.ts` + `src/oauth-keys.ts` (signing), `src/oauth-claims.ts` (membership / role / entitlement claim builders).

App licensing modes and the data model behind entitlements are covered in [Hierarchy.md → Apps & licensing](Hierarchy.md#apps--licensing). The signing-key rotation procedure is in [Operations.md → OAuth signing-key rotation](Operations.md#oauth-signing-key-rotation).

## Federated login (Puff as client)

Puff can also be the **client** to GitHub / Google / Microsoft so users sign in with an external identity. Standard OAuth 2.1 Authorization Code with S256 PKCE; provider configs are static (`src/oauth-providers.ts`), credentials come from `OAUTH_<PROVIDER>_CLIENT_ID` + `OAUTH_<PROVIDER>_CLIENT_SECRET` env vars.

The provider buttons on `/login` and `/account` are HTMX-loaded from `/api/providers`, which filters by `listConfiguredProviders(env)`. A provider with no credentials configured is omitted from the UI and 404s its `/login/<provider>` route if visited directly.

Two endpoints under `functions/login/[provider]/`: the start (`index.ts`) generates a state nonce + PKCE pair, stashes them in a short-lived `oauth_state` cookie (HttpOnly, SameSite=Lax — the cookie must survive the cross-site redirect back), and 302s to the provider's authorize URL. The callback (`callback.ts`) verifies the state, exchanges the code, calls the provider's userinfo endpoint (plus `/user/emails` for GitHub), and lands the user in one of three places:

1. **Existing link** — `(provider, provider_user_id)` already in `external_identities`: issue a session immediately. Bypasses the 2FA gate the same way passkey login does — the federated provider's auth is the second factor.
2. **Authenticated caller** — a valid `session_token` cookie is present: `linkExternalIdentity` adds the row, the user lands on `/account` with the new linked account visible.
3. **Anyone else** — `createFederatedSignupToken` mints a 15-minute single-use token carrying `(provider, provider_user_id, email, email_verified, display_name)`, and the user is redirected to `/federated-signup?token=…`. That page previews the proposed username + email; the POST to `/api/federated-signup/confirm` consumes the token, creates the user, links the identity, and issues a session. Email-match auto-linking is deliberately not offered — users with an existing Puff account must sign in first and link the provider from `/account`.

Unlinking is gated by `unlinkExternalIdentity`'s "another usable credential exists" check — a user must keep at least one of: an active password, an active passkey, or another linked identity.

Domain modules: `src/oauth-providers.ts` (registry + per-provider userinfo extractors), `src/oauth-outbound.ts` (build authorize URL / exchange code / fetch userinfo), `src/external-identities.ts`, `src/federated-signup-tokens.ts`, `src/utilities/oauth-state-cookie.ts`. The per-provider setup procedure is in [Operations.md → Adding a federated login provider](Operations.md#adding-a-federated-login-provider).

## Billing (Phase 9)

Puff acts as a payment orchestrator: orgs subscribe to apps through a provider-hosted checkout flow, and Puff records entitlement state locally while treating the payment provider as the source of truth for billing fields.

### Request and data flow

```text
org subscribe → startSubscriptionCheckout → Stripe-hosted checkout
                                          ↓
                              customer.subscription.created webhook
                                          ↓
                     billing_webhook_events (dedup) + subscriptions (upsert)
                                          ↓
                              isLicensed checks ENTITLED_STATUSES
```

Provider events feed back via `POST /api/billing/webhook`. The webhook handler (`src/billing-webhook.ts`) processes `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, and `invoice.voided`. Each event is recorded once in `billing_webhook_events` on a `(provider, provider_event_id)` unique key; the dedup insert and the state-change query run in one transaction so a replay rolls back harmlessly to a 200 ack, and a processing failure also rolls back the dedup row so the provider's retry is honoured.

Metadata (`org_uuid`, `app_uuid`, `tier`) is set on `subscription_data` at checkout time so the created subscription carries the context the webhook handler needs to upsert the local `subscriptions` row.

### Source-of-truth split

- **Provider-as-SOR** for billing fields: `status`, period dates, `canceled_at`, `cancel_at`, `trial_end`. These are written exclusively by the webhook handler, never by the UI endpoints.
- **Puff-as-SOR** for entitlement state: `isLicensed` in `src/entitlements.ts` reads the local `subscriptions` row and checks `ENTITLED_STATUSES` (only `"active"` and `"trialing"`). Payment-up-front, zero grace: `"past_due"`, `"canceled"`, `"paused"`, and `"incomplete"` all return `licensed: false` immediately. A missing subscription row for a billed app (`app_licensing_mode` anything other than `"none"`) also returns `licensed: false` — there is no implicit free tier.

### Provider abstraction

`src/billing-stripe.ts` implements the `BillingProvider` interface from `src/billing.ts` using plain `fetch` (no Stripe SDK dependency, same rationale as `mailer.ts`). The provider is injected as a parameter so the domain layer in `src/billing.ts` is provider-agnostic and tests can pass a fake. Adapter methods throw on error; the domain layer maps those throws to `502` error envelopes. Swapping to another provider (Paddle, Lemon Squeezy) means writing a new adapter and updating the call sites that call `createStripeProvider(env)`.

### `/api/billing/*` tree

The `/api/billing/` prefix is the one `cors: "external"` subtree in the `functions/api/_middleware.ts` policy table: it gets a Hyperdrive `pg` client (`db: true`) with no session auth (`auth: false`) and the `externalCorsGuard` instead of the same-origin write guard. Stripe and registered apps are non-browser clients authenticated by signature or HTTP Basic credentials respectively, so cookie-based CSRF protection does not apply and the same-origin block would be wrong (they are legitimately cross-origin). `externalCorsGuard` answers the `OPTIONS` preflight and echoes an allowlisted `Origin` (`EXTERNAL_CORS_ORIGINS`), but never blocks on origin.

| Endpoint                             | Auth             | Purpose                                                                                                                                            |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/billing/webhook`          | Stripe signature | Webhook receiver — verifies `stripe-signature`, then delegates to `handleStripeWebhookEvent`. Returns 400 on bad signature, 503 when unconfigured. |
| `POST /api/billing/usage/[app_uuid]` | HTTP Basic (app) | Usage ingest for `usage`-mode apps. The credentialed app must match the path `[app_uuid]`; 403 otherwise. JSON in / JSON out.                      |

Org-facing billing endpoints live under `functions/api/organisations/[org_uuid]/billing/` and are gated by session auth and `org:billing:read` / `org:billing:write` permissions. The subscribe entry point is at `functions/api/organisations/[org_uuid]/apps/[app_uuid]/subscribe.ts`.

### Usage metering (cron)

`src/cron.ts`'s daily tick (`0 0 * * *`) runs two rollup calls via `recomputeUsageRollups` (previous full UTC day + current in-progress day) and then calls `syncUsageRollups`, which pushes unsynced `usage_rollups` rows to Stripe as **Billing Meter events** (`POST /v1/billing/meter_events`). The `event_name` sent to Stripe equals the `metric` string on the rollup row — the operator must configure a Stripe Billing Meter whose `event_name` matches each metric. A per-`(app, org, metric, day)` `identifier` prevents double-billing on retry. The provider sync only runs when `STRIPE_SECRET_KEY` is configured; failures are logged and retried on the next daily tick.

### Billing-contact email

The address on each Stripe customer (used for Stripe's receipts and dunning) is **resolved**, not free-typed per subscription. The effective email is `billing_customers.billing_email` (an operator override) when set, otherwise `resolveBillingEmail(org)` — which ranks org members holding a verified primary email: billing-only → billing+owner → billing+admin → any-billing → owner (final fallback), tiebreaking on earliest membership then email. The resolved address is written to the Stripe customer at creation (`ensureCustomer`), re-synced immediately when the override changes (`POST /api/organisations/[org_uuid]/billing/email`), and reconciled by a second **hourly** Cron Trigger (`0 * * * *`) that re-resolves every customer and patches the provider only when the effective address drifts from the stored `billing_customers.synced_email`. Stripe's Customer object holds a single email, so to reach multiple billing-role members the override should point at a distribution alias.

### Billing environment variables

| Variable                        | Default | Purpose                                                                                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`             | unset   | Stripe API key, sent as a `Bearer` token. **Secret** — set via `wrangler secret put`.                                     |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | unset   | Webhook endpoint signing secret. **Secret** — set via `wrangler secret put`. When unset the webhook endpoint returns 503. |

## Environment variables

Operator-configurable runtime values, read from `context.env` (Cloudflare Pages Functions binding). Set non-secret values as plain `vars` in `wrangler.jsonc` for production, or in `.dev.vars` / `.env` for local development. Secrets must go through `wrangler secret put`.

### Auth & cookies

| Variable                  | Default    | Purpose                                                                                                                                                                                                              |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_MAX_AGE_SECONDS` | `2592000`  | Lifetime of the `session_token` cookie issued after login (30 days). Distinct from the server-side session row expiry in `src/sessions.ts` (7 days) — a cookie can outlive the DB row and the server will reject it. |
| `SECURE_COOKIE`           | unset      | When truthy, appends `Secure` to every `Set-Cookie` issued by the login/logout flows. Should be set in production.                                                                                                   |
| `COOKIE_SAMESITE`         | `Lax`      | `SameSite` policy on auth cookies. Valid: `Lax`, `Strict`, `None`. `Lax` keeps the cookie alive across the email-verification-link top-level navigation; `None` requires `Secure`.                                   |
| `APP_NAME`                | `PuffAuth` | TOTP issuer name shown by authenticator apps and embedded in the QR-code URI.                                                                                                                                        |
| `APP_URL`                 | unset      | Absolute public origin (e.g. `https://auth.example.com`, no trailing slash). Required: used to build email links and the federated-login redirect URIs.                                                              |

### Email (Mailtrap)

| Variable               | Default                                 | Purpose                                                                                                                          |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MAILTRAP_TOKEN`       | unset                                   | API token used as the `Bearer` credential. **Secret** — set via `wrangler secret put`.                                           |
| `MAILTRAP_SENDER`      | unset                                   | Verified sender email address.                                                                                                   |
| `MAILTRAP_SENDER_NAME` | `APP_NAME` then `PuffAuth`              | Sender display name.                                                                                                             |
| `MAILTRAP_API_URL`     | `https://send.api.mailtrap.io/api/send` | Send endpoint. Override to a sandbox URL (`https://sandbox.api.mailtrap.io/api/send/{inbox_id}`) for testing without delivering. |

### Password policy

| Variable                  | Default | Purpose                                                                                                                                                    |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_PASSWORD_LENGTH`     | `12`    | Minimum accepted length. Can only **raise** above the built-in floor of `12`. When raised, a login with a now-too-short password is paused for an upgrade. |
| `REQUIRE_NUMBER`          | off     | Require at least one digit. Soft suggestion when `REQUIRE_ZXCVBN` is on.                                                                                   |
| `REQUIRE_CAPITAL`         | off     | Require an uppercase letter. Soft suggestion when `REQUIRE_ZXCVBN` is on.                                                                                  |
| `REQUIRE_SPECIAL_CHAR`    | off     | Require a non-alphanumeric character (spaces count). Soft suggestion when `REQUIRE_ZXCVBN` is on.                                                          |
| `REQUIRE_NOT_COMPROMISED` | off     | Hard-reject passwords found in HIBP breach data (k-anonymity prefix query). Fail-open on network error.                                                    |
| `SHOW_ZXCVBN`             | off     | Display the zxcvbn strength estimate in the requirements UI without enforcing a minimum score. Auto-enabled when `REQUIRE_ZXCVBN` is set.                  |
| `REQUIRE_ZXCVBN`          | off     | Require zxcvbn score ≥ 3. When set, the character-class flags become suggestions; `MIN_PASSWORD_LENGTH` still applies as a hard floor.                     |

### OAuth signing keys

Active key material lives in the `KV_OAUTH_KEYS` KV namespace (bound in `wrangler.jsonc`) under `oauth:keys:active` / `oauth:keys:retired`; the rotation cron writes to it. See [Operations.md → OAuth signing-key rotation](Operations.md#oauth-signing-key-rotation).

| Variable                            | Default | Purpose                                                                                                                                                                                                    |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OAUTH_SIGNING_KEY_PRIVATE`         | unset   | **Migration fallback** for the KV `oauth:keys:active` entry. Read when KV is empty (local dev, post-provision seed). **Secret** when used. After ≥ one rotation in production this binding can be removed. |
| `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` | unset   | **Migration fallback** for the KV `oauth:keys:retired` entry. Read when KV is empty. JSON string of the public JWK (`kty` / `crv` / `x` / `y` only — no `d`).                                              |
| `OAUTH_KEY_ROTATION_INTERVAL_DAYS`  | `7`     | Minimum age (in days) of the active key before the daily cron rotates it again — so the default cadence is weekly. Set lower in staging to rehearse the rotation path, higher to slow the cadence.         |

### Admin endpoints

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPERATOR_USER_UUIDS` | unset | Comma- or whitespace-separated list of user UUIDs allowed to call `/api/admin/*` endpoints (manual key rotation, retired-key promotion). When unset, the whole admin section returns 503 — the safe default for a misconfigured deploy. The endpoint sits behind session auth. |

### Federated login providers

Each provider needs both vars set or its `/login/<provider>` route 404s.

| Variable                        | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `OAUTH_GITHUB_CLIENT_ID`        | GitHub OAuth App client_id.                                                 |
| `OAUTH_GITHUB_CLIENT_SECRET`    | GitHub OAuth App client_secret. **Secret**.                                 |
| `OAUTH_GOOGLE_CLIENT_ID`        | Google OAuth 2.0 client_id.                                                 |
| `OAUTH_GOOGLE_CLIENT_SECRET`    | Google OAuth 2.0 client_secret. **Secret**.                                 |
| `OAUTH_MICROSOFT_CLIENT_ID`     | Microsoft Entra ID Application (client) ID. Multi-tenant `common` endpoint. |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | Microsoft Entra ID client secret. **Secret**.                               |

Bindings (`HYPERDRIVE`, `ASSETS`, `KV_OAUTH_KEYS`) and the cron trigger schedule live in `wrangler.jsonc`, not as env vars.
