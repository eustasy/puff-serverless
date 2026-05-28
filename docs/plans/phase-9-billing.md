# Phase 9 — Billing

Phase 7 wired up app **licensing modes** (`none` / `seat` / `usage` / `floating`) and pushed entitlements into the KV store, but no money flows yet. Phase 8 turns those modes into actual billable subscriptions: orgs pay for the apps they license, the operator receives revenue, entitlements track payment state, and apps that depend on Puff for licensing get a single source of truth.

## Table of Contents

- [Context](#context)
- [Architecture decisions](#architecture-decisions)
- [Schema (`sql/`)](#schema-sql)
- [Domain modules (`src/`)](#domain-modules-src)
- [Endpoints (`functions/`)](#endpoints-functions)
- [Frontend (`public/`)](#frontend-public)
- [Subscription lifecycle](#subscription-lifecycle)
- [Usage metering](#usage-metering)
- [Audit hooks](#audit-hooks)
- [Operations](#operations)
- [Open decisions](#open-decisions)
- [Execution plan](#execution-plan)
- [Carry-forward / deferred](#carry-forward--deferred)
- [Out of scope](#out-of-scope)

## Context

The licensing model is already in place:

- Apps declare a mode at registration (`apps.app_licensing_mode`, CHECK-constrained `'none' | 'seat' | 'usage' | 'floating'`).
- Per-org/team/user entitlements live as KV rows under the app owner namespace (`license:tier`, `perm:*`, etc.); see `docs/Hierarchy.md → Entitlements`.
- `summariseLicensing` already produces a per-org readout (assigned vs. active vs. pool max).
- Orgs already have a `billing` role with read-only entitlements visibility, ready to be expanded with billing-management capabilities.

What's missing is everything money-related: payment methods, subscriptions, invoices, usage rollups, dunning, and the org-facing billing UI.

## Architecture decisions

All settled.

- [x] **Payment provider:** Stripe, with the adapter thin enough to swap to a merchant-of-record (Paddle / Lemon Squeezy) later.
- [x] **Source of truth for subscriptions:** provider-as-SOR for billing fields; Puff-as-SOR for entitlements. Webhook handler is the synchronising layer.
- [x] **Subscription granularity:** per `(org, app)`. Apps are independent products with independent licensing modes.
- [x] **Tax model:** operator-handled via Stripe Tax + per-region registrations (follows from Stripe).
- [x] **Trial policy:** per-app, on `apps.app_default_trial_days NULL`.
- [x] **Currencies:** single-currency at launch. Multi-currency revisited on first customer ask.
- [x] **Self-serve vs. operator-only signup:** self-serve for all licensing modes including `floating`. Bundle pricing (e.g. selling a floating pool plus a couple of seat apps under one negotiated deal) is deferred — when it lands it will be modelled as separate `(org, app)` subscriptions sharing a discount/coupon, not as a new "bundle subscription" type.

## Schema (`sql/`)

New tables. Mirror existing conventions: snake_case columns, UUID PKs, explicit FKs with `ON DELETE` behaviour matching the data's audit value (most billing data should `SET NULL` rather than cascade — invoices outlive cancelled subscriptions).

- [x] `sql/billing_customers.sql` — one row per org with a Stripe customer ID (or equivalent). `org_uuid` PK (and FK to `organisations`, `ON DELETE CASCADE` — when an org is deleted the operator must handle the customer-side closeout separately, but the local record goes). Stores `provider`, `provider_customer_id`, `default_payment_method_id` (nullable), `tax_id` (nullable), `billing_email` (override; otherwise falls back to the org's `billing` role members).
- [x] `sql/subscriptions.sql` — per (org, app). PK `subscription_uuid`. FKs to `organisations` and `apps`. `provider`, `provider_subscription_id`, `status` (CHECK-constrained: `'trialing' | 'active' | 'past_due' | 'canceled' | 'paused' | 'incomplete'`), `tier` (string — references `license:tiers:*` keys in `app_key_values`), `current_period_start`, `current_period_end`, `cancel_at`, `canceled_at`, `trial_end`, `created_at`. UNIQUE on `(org_uuid, app_uuid)` so an org has at most one active sub per app.
- [x] `sql/invoices.sql` — record of each issued invoice. PK `invoice_uuid`. FKs to `organisations` and `subscriptions` (`SET NULL` on subscription cascade so historical invoices survive cancellation). `provider`, `provider_invoice_id`, `status` (`'draft' | 'open' | 'paid' | 'void' | 'uncollectible'`), `amount_cents`, `currency`, `period_start`, `period_end`, `due_at`, `paid_at`, `hosted_invoice_url` (provider-hosted PDF/HTML), `created_at`. Append-only after issuance.
- [x] `sql/usage_events.sql` — for `usage` mode apps. Raw events as apps report them. PK `event_uuid`. FKs to `apps` / `organisations` / `users` (the user the event is attributed to; nullable so org-level events are also representable). `metric` (string — what's being metered), `quantity` (number), `occurred_at`, `received_at`, `idempotency_key` (UNIQUE per `(app_uuid, idempotency_key)` so apps can safely retry). Append-only.
- [x] `sql/usage_rollups.sql` — aggregated daily counters per `(app, org, metric, day)` for fast invoice computation. Recomputed nightly from `usage_events`; serves both the operator dashboard and the provider's usage-record sync. Composite PK; the rollup job is idempotent on re-run.
- [x] `sql/billing_pricing.sql` — per-app pricing catalog. Holds tier names, prices, currencies, intervals (`billing_interval` — `interval` is a reserved word), and the provider's `price_id` for each row. Puff owns the catalog; Stripe price IDs are stored alongside as the link to the payment rail. Lets `summariseLicensing` and the org billing UI render prices without a round-trip to the provider.
- [x] `sql/billing_webhook_events.sql` — webhook idempotency ledger. PK `(provider, provider_event_id)`, `event_type`, `received_at`. No FK dependencies. Added this phase (not in the original list) to give the webhook handler exactly-once processing against provider retries.

Schema-import order: append after the existing tables; FK dependencies are `organisations` → `billing_customers`, `apps` + `organisations` → `subscriptions`, `subscriptions` + `organisations` → `invoices`, `apps` + `organisations` (+ optionally `users`) → `usage_events` + `usage_rollups`. All have no impact on existing tables.

One additive migration on an existing table:

- [x] `sql/organisations.sql` — add `org_locale TEXT` (NULL = fall back to `'en'`). Used as the locale on Stripe customer records and invoices.
- [x] `sql/apps.sql` — add `app_default_trial_days INT NULL` (NULL = no trial). Required by the subscribe flow (Trial policy decision above); was missing from the original schema list, added during O1.

## Domain modules (`src/`)

- [x] `src/billing.ts` — provider-agnostic entry points: `getCustomer`, `ensureCustomer`, `listSubscriptions`, `getSubscriptionForApp`, `createSubscription`, `updateSubscription` (tier changes with proration), `cancelSubscription` (immediate vs. end-of-period), `startSubscriptionCheckout` (self-serve handoff), `listInvoices`/`getInvoice`, `listPricing`/`getPricing`. Provider injected as a parameter (swappable); every function takes `dbClient` first and returns the canonical envelope.
- [x] `src/billing-stripe.ts` — Stripe adapter implementing the `BillingProvider` interface via `fetch` (no SDK dependency, per `mailer.ts`). Adapter methods throw; `billing.ts` maps to a 502 envelope. Includes the webhook signature verifier (WebCrypto HMAC-SHA256, constant-time). Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SIGNING_SECRET`.
- [x] `src/billing-webhook.ts` — `handleStripeWebhookEvent` processes inbound events. Dedup + state change run in ONE transaction keyed on `(provider, provider_event_id)` in the new `billing_webhook_events` table (added this phase — not in the original schema list): a replay rolls back to a 200 ack, a processing failure rolls back the dedup row too so the provider's retry is honoured. Maps `customer.subscription.*` → subscription upsert/cancel (by `(org,app)` from subscription metadata) and `invoice.*` → invoice upsert (attributed via the subscription), emitting the matching `billing.*` audit events. Signature verified upstream in the endpoint. NOTE: checkout sets metadata on `subscription_data` so the created subscription carries `org_uuid`/`app_uuid`/`tier`.
- [x] `src/usage.ts` — `recordUsageEvent` (idempotent on `(app_uuid, idempotency_key)`); `recomputeUsageRollups` (idempotent daily aggregate, called nightly by `src/cron.ts`); `syncUsageRollups` pushes unsynced rollups to the provider via Stripe **Billing Meter events** (`/v1/billing/meter_events`, keyed by metric → `event_name`, org customer, with a per-`(app,org,metric,day)` `identifier` for idempotency), marking `synced_at`. Wired into `src/cron.ts` after the recompute. NOTE: chose Billing Meters over per-subscription-item `usage_records` so no metric→subscription-item mapping is needed; the operator must configure a Stripe meter whose `event_name` matches each metric.
- [x] Extend `src/entitlements.ts → isLicensed` so subscription state participates in the licensing decision. The licensing chain becomes: if the app's `app_licensing_mode = 'none'`, licensed; otherwise an active or trialing subscription is required, with no grace for `past_due` / `canceled` / `paused`. Then fall through to the existing tier/floating-pool checks. A missing subscription row for a billed app means unlicensed — there is no implicit free tier.

## Endpoints (`functions/`)

- [x] `functions/api/db/auth/organisations/[org_uuid]/billing/` — the org-facing billing tree. Permission split (`org:billing:read` / `org:billing:write`) done in S3. Mutating endpoints verify the subscription belongs to the path org (returning 404, not 403, on mismatch to avoid existence leakage).
  - `summary.ts` (GET, `org:billing:read`) — current subscriptions.
  - `subscriptions/[subscription_uuid]/{update,cancel}.ts` (POST, `org:billing:write`) — change tier (with optional `proration`), cancel (immediate or end-of-period); emit `BILLING_SUBSCRIPTION_UPDATED` / `_CANCELED`.
  - `payment-methods/portal.ts` (POST, `org:billing:write`) — single redirect to the Stripe-hosted customer portal (replaces the four list/add/remove/set-default endpoints — idiomatic for Stripe).
  - `invoices/{list,one}.ts` (GET, `org:billing:read`) — list invoices; `one` redirects to the hosted-invoice URL.
- [x] `functions/api/db/auth/organisations/[org_uuid]/apps/[app_uuid]/subscribe.ts` (POST, `org:billing:write`) — self-serve subscribe: `ensureCustomer` then `startSubscriptionCheckout`, redirect to provider-hosted checkout. The subscription row is created later by the webhook (no `.created` emit here).
- [x] `functions/api/billing/_middleware.ts` — DB-connection middleware modelled on `functions/oauth/_middleware.ts`: opens a Hyperdrive `pg` client, no cross-origin guard, no session auth. The `/api/db/` cross-origin write guard does not apply to `/api/billing/*` because the guard lives in `functions/api/db/_middleware.ts` and only runs for routes under that subtree.
- [x] `functions/api/billing/webhook.ts` — provider webhook receiver. POST-only. Reads the raw body verbatim, verifies the `stripe-signature` header (`verifyStripeSignature`, only needs the signing secret) before any DB work, then delegates to `handleStripeWebhookEvent`. Returns 400 on bad signature, 503 if unconfigured, the handler's status (200/500) otherwise.
- [x] `functions/api/billing/usage/[app_uuid].ts` (POST, JSON in/out) — apps push usage events here. **Authenticated by app credentials** (HTTP Basic via `parseBasicAuth` + `verifyAppCredentials`); the credentialed app must match the path `[app_uuid]` (403 otherwise). Validates the org has a subscription for the app; records via `recordUsageEvent` (idempotency-keyed); emits `BILLING_USAGE_RECORDED`.
- [~] **Operator endpoints** — under `functions/api/db/auth/admin/billing/`, behind the existing operator allowlist (`OPERATOR_USER_UUIDS`; the Phase 7 "TBD" is resolved). **Done (read-only):** `subscriptions.ts` (all subs across orgs) and `usage.ts` (rollup dashboard, optional `?org_uuid=`). **Deferred (need a product decision):** _comp seats_ — conflicts with the "no implicit free tier" rule (would need a $0/100%-off subscription or a new "comped" status); _manual invoice issuance_ — needs a defined one-off-invoice flow. _Refunds_ are intentionally manual via the Stripe dashboard (see Out of scope).

## Frontend (`public/`)

- [x] Org list billing link — the org list is server-rendered by `functions/api/db/auth/organisations/list.ts` (not static `account.html`), so the per-row "Billing" link is gated there with `can(org.roles, "org:billing:read")`.
- [x] `functions/organisations/[org_uuid]/billing.ts` — server-rendered billing page (Pages Function, mirrors `[org_uuid].ts`: session-presence check + redirect, real permission deferred to the HTMX-loaded fragments). Sections: current subscriptions (`/billing/summary`), payment-method portal button, billing history (`/billing/invoices/list`). No "upcoming invoice" — no local data source; next-billing date comes from `current_period_end`.
- [ ] Self-serve "Subscribe" button on a per-app entitlements view — **deferred: there is no app/entitlements page in the UI today** (the org management fragment only shows teams/members). The `subscribe.ts` endpoint exists and lands back on the billing page; the button needs an app-entitlements page to live on first. Flagged for follow-up.

## Subscription lifecycle

```
trialing → active → past_due → canceled
                 → paused
                 → active (resubscribed)
```

- [x] **Trial start.** `trial_end` flows from `apps.app_default_trial_days` through `createSubscription`/`startSubscriptionCheckout`; `ENTITLED_STATUSES` includes `trialing`, so `isLicensed` is true during the trial.
- [x] **Active.** Webhook `invoice.paid` / `invoice.payment_succeeded` → invoice marked paid; `customer.subscription.updated` keeps status in sync.
- [x] **Past due.** Access-control side done: a `past_due` subscription (synced from the webhook) is excluded from `ENTITLED_STATUSES`, so `isLicensed` flips false immediately. `invoice.payment_failed` emits `billing.payment.failed`. **Deferred:** the pre-renewal / on-failure _warning emails_ to `billing`-role members are not implemented (no dunning mailer yet) — flagged for follow-up.
- [x] **Canceled.** `customer.subscription.deleted` → status `canceled`; `isLicensed` false. Entitlement KV rows are left in place (not deleted).
- [x] **Paused.** A `paused` status synced from the webhook is excluded from `ENTITLED_STATUSES` (emits `billing.subscription.paused`); `isLicensed` false until resumed.
- [x] **Resume / upgrade / downgrade.** `updateSubscription` changes tier with a `prorationBehavior` option (`always_invoice` charges immediately); the webhook brings state back.

## Usage metering

For `usage`-mode apps:

- [x] **Apps push events** to `POST /api/billing/usage/[app_uuid]` (HTTP Basic app credentials).
- [x] **Idempotency** enforced by the unique `(app_uuid, idempotency_key)` constraint — retries are safe.
- [x] **Nightly rollup** in `src/cron.ts` aggregates `usage_events` → `usage_rollups`, idempotently.
- [x] **Provider sync.** `syncUsageRollups` pushes unsynced rollups via Stripe **Billing Meter events** (not the older `subscriptionItem.createUsageRecord`, which would need a metric→subscription-item map). `usage_rollups.synced_at` tracks state; a per-`(app,org,metric,day)` `identifier` prevents double-billing on retry.
- [ ] **Operator dashboard** — admin endpoint showing usage rollups per org per app. **Deferred** with the other operator endpoints (see below).

## Audit hooks

New event types in `src/hooks/events.ts`. All severity `notice` unless flagged.

- [x] `billing.customer.created`
- [x] `billing.subscription.created`, `.updated` (tier change), `.canceled`, `.paused`, `.resumed` — severity `notice`; `.canceled` upgraded to `alert`.
- [x] `billing.payment.succeeded`, `.failed` — `.failed` is `warning`; repeated `.failed` events for the same subscription escalate to `alert`.
- [x] `billing.invoice.issued`, `.paid`, `.voided`.
- [x] `billing.usage.recorded` — severity `debug` to keep volume manageable; the audit log isn't the metering store.

Webhook handlers emit these as part of the synchronisation; org-UI actions emit them at the call site like every other endpoint.

## Operations

- [x] **`docs/Operations.md` additions** (S6): billing-audit timeline, webhook idempotency model, nightly rollup + provider sync, switching payment provider, and a "known gaps" note (dunning emails, operator write endpoints, manual refunds). The pre-renewal warning-email cadence is documented as a gap, not a procedure — see deferred item below.
- [x] **`docs/Deployment.md` additions** (S6): pushing the two Stripe secrets, the webhook endpoint URL + which events to enable, per-app product/price config, the Stripe Billing Meter setup for usage apps, Stripe Tax note.
- [x] **`docs/Architecture.md` additions** (S6): billing flow, new env vars, the `/api/billing/*` cross-origin-guard exemption, and the `isLicensed` subscription gate.
- [x] **Refund handling.** Documented as manual-via-dashboard; the `invoice.voided` webhook flips the local invoice to `void` and does not touch entitlements.
- [x] **Compliance.** PCI delegated to Stripe. `deleteUser` does not cascade to billing data (billing is org-keyed; `usage_events.user_uuid` is `ON DELETE SET NULL`). `deleteOrganisation` now **refuses (409) on an outstanding balance** (open/uncollectible invoices) — important because `invoices.org_uuid` is `ON DELETE CASCADE` and would otherwise destroy unsettled records.
- [ ] **Dunning / pre-renewal warning emails** to `billing`-role members — **deferred:** needs a mailer template + a cadence decision (Stripe already sends its own dunning; "days leading up to renewal" needs `invoice.upcoming` handling). The access-control side (immediate `isLicensed` flip on `past_due`) is done.

## Open decisions

All resolved.

- [x] **Payment provider** — Stripe.
- [x] **Subscription SOR** — provider for billing fields, Puff for entitlement state.
- [x] **Self-serve vs. operator-gated** — self-serve across all licensing modes (including `floating`). Bundles deferred.
- [x] **Multi-currency** — single-currency at launch.
- [x] **Free-tier policy** — no implicit free tier. `app_licensing_mode = 'none'` is the only "free" state; apps with any other mode require an active or trialing subscription to be licensed. A missing subscription row means the app is not available to the org.
- [x] **Grace window length** — zero. Payment-up-front; on failed renewal `isLicensed` flips false the same moment the charge fails. No `BILLING_GRACE_PERIOD_DAYS` env var.
- [x] **Receipt locale** — new `org_locale` column on `organisations` (added as a small migration in this phase). Falls back to `en` if NULL.
- [x] **Tax-id capture** — captured on `billing_customers.tax_id` so the operator has it on file and Stripe shows it on invoices, but Puff itself does not branch billing logic on it.

## Execution plan

The work splits into two model tracks. **Opus** owns anything where a wrong call is costly — the access-control decision, the provider-abstraction boundary, webhook idempotency/replay, and signature/credential auth. **Sonnet** owns well-specified, pattern-following work — SQL tables, audit constants, docs, frontend HTML, and endpoint wiring over a finished domain layer. This Opus session coordinates: it dispatches the Sonnet-track work to sub-agents, owns the Opus-track work, and integrates.

Critical path: **S1 → O1 → O2**.

### Sonnet sessions

- **S1 — Schema** _(no deps)_: all six new tables + the `org_locale` migration. Columns / FKs / CHECKs / import-order are fully specified above.
- **S2 — Audit constants** _(no deps)_: add the `billing.*` event types to `src/hooks/events.ts` with the listed severities. Emission happens in the Opus sessions.
- **S3 — Permission split** _(no deps; gates S4)_: split `org:billing` → `org:billing:read` / `org:billing:write` in `src/permissions.ts` (write → `owner`/`billing`, read → `admin`).
- **S4 — Org-facing endpoints** _(needs O1)_: `summary.ts`, `invoices/{list,one}.ts`, `subscriptions/[uuid]/{update,cancel}.ts`, `payment-methods/*` — thin wiring over `src/billing.ts`.
- **S5 — Frontend** _(needs S4)_: `account.html` billing link, `functions/organisations/[org_uuid]/billing.ts` page, subscribe button + checkout landing.
- **S6 — Docs** _(last)_: Operations / Deployment / Architecture additions.
- **Usage (recording half)** _(needs S1)_: `src/usage.ts` event recording + the nightly idempotent rollup in `src/cron.ts`.

### Opus sessions

- **O1 — Core domain + provider adapter** _(needs S1)_: `src/billing.ts` (envelope contracts, proration, cancel-now-vs-period-end) + `src/billing-stripe.ts` behind the swappable interface.
- **O2 — Webhook + billing auth surface** _(needs O1, S1, S2)_: `src/billing-webhook.ts` (signature verify, `provider_event_id` idempotency, replay-safe sync, audit emission) + `functions/api/billing/_middleware.ts` + `webhook.ts`.
- **O3 — Entitlements** _(needs S1)_: extend `src/entitlements.ts → isLicensed` — subscription state gates licensing, zero grace, no implicit free tier.
- **Usage (auth half)** _(needs O1)_: `functions/api/billing/usage/[app_uuid].ts` app-credential auth + Stripe usage-record idempotency.

### Sequence

```
S1 schema ─┬─> O1 domain+adapter ─┬─> O2 webhook+auth
           │                      ├─> S4 endpoints ─> S5 frontend
S2 audit ──┘                      └─> usage (Opus auth + Sonnet recording)
S3 perms ──────────────────────────> (gates S4)
O3 entitlements (parallel, needs only S1)         S6 docs (last)
```

## Carry-forward / deferred

- [ ] **Optional second database** (from old-repo issue [#19](https://github.com/eustasy/puff-server/issues/19)). Splitting auth from billing would lose the cross-table FK / `ON DELETE CASCADE` integrity the schema relies on, and there is no domain today that needs its own scaling/regioning/compliance boundary. Single-DB stays the default. Revisit only if a billing-specific compliance or scaling requirement appears (e.g. PCI scope reduction by physically isolating payment metadata — though Stripe-as-SOR makes that moot).

## Out of scope

Billing-adjacent but explicitly deferred:

- **Reseller / partner programme** — a layer above orgs that resells Puff licences to its own customers. Not modelled. Phase 9+ if it materialises.
- **Promotional / discount codes** — coupons, percent-off, fixed-amount-off. Stripe supports these natively; Puff would just need a thin pass-through in the subscribe endpoint. Track as a follow-up after the base lifecycle works.
- **Itemised usage breakdowns in the org UI** — the rollup table makes this tractable, but it's a polish item, not a launch blocker.
- **Cross-org bulk pricing / enterprise contracts** — manual operator action via comp-seat / custom-invoice for now.
- **In-app upsell prompts** — the question of whether Puff should drive upgrade prompts inside the apps it logs users into. Out of scope here; if needed, would be a separate `puff:billing-status` OIDC claim.
- **Refund automation** — refunds stay manual via the operator dashboard.
