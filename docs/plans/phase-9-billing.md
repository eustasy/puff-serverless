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

- [ ] `sql/billing_customers.sql` — one row per org with a Stripe customer ID (or equivalent). `org_uuid` PK (and FK to `organisations`, `ON DELETE CASCADE` — when an org is deleted the operator must handle the customer-side closeout separately, but the local record goes). Stores `provider`, `provider_customer_id`, `default_payment_method_id` (nullable), `tax_id` (nullable), `billing_email` (override; otherwise falls back to the org's `billing` role members).
- [ ] `sql/subscriptions.sql` — per (org, app). PK `subscription_uuid`. FKs to `organisations` and `apps`. `provider`, `provider_subscription_id`, `status` (CHECK-constrained: `'trialing' | 'active' | 'past_due' | 'canceled' | 'paused' | 'incomplete'`), `tier` (string — references `license:tiers:*` keys in `app_key_values`), `current_period_start`, `current_period_end`, `cancel_at`, `canceled_at`, `trial_end`, `created_at`. UNIQUE on `(org_uuid, app_uuid)` so an org has at most one active sub per app.
- [ ] `sql/invoices.sql` — record of each issued invoice. PK `invoice_uuid`. FKs to `organisations` and `subscriptions` (`SET NULL` on subscription cascade so historical invoices survive cancellation). `provider`, `provider_invoice_id`, `status` (`'draft' | 'open' | 'paid' | 'void' | 'uncollectible'`), `amount_cents`, `currency`, `period_start`, `period_end`, `due_at`, `paid_at`, `hosted_invoice_url` (provider-hosted PDF/HTML), `created_at`. Append-only after issuance.
- [ ] `sql/usage_events.sql` — for `usage` mode apps. Raw events as apps report them. PK `event_uuid`. FKs to `apps` / `organisations` / `users` (the user the event is attributed to; nullable so org-level events are also representable). `metric` (string — what's being metered), `quantity` (number), `occurred_at`, `received_at`, `idempotency_key` (UNIQUE per `(app_uuid, idempotency_key)` so apps can safely retry). Append-only.
- [ ] `sql/usage_rollups.sql` — aggregated daily counters per `(app, org, metric, day)` for fast invoice computation. Recomputed nightly from `usage_events`; serves both the operator dashboard and the provider's usage-record sync. Composite PK; the rollup job is idempotent on re-run.
- [ ] `sql/billing_pricing.sql` — per-app pricing catalog. Holds tier names, prices, currencies, intervals, and the provider's `price_id` for each row. Puff owns the catalog; Stripe price IDs are stored alongside as the link to the payment rail. Lets `summariseLicensing` and the org billing UI render prices without a round-trip to the provider.

Schema-import order: append after the existing tables; FK dependencies are `organisations` → `billing_customers`, `apps` + `organisations` → `subscriptions`, `subscriptions` + `organisations` → `invoices`, `apps` + `organisations` (+ optionally `users`) → `usage_events` + `usage_rollups`. All have no impact on existing tables.

One additive migration on an existing table:

- [ ] `sql/organisations.sql` — add `org_locale TEXT` (NULL = fall back to `'en'`). Used as the locale on Stripe customer records and invoices.

## Domain modules (`src/`)

- [ ] `src/billing.ts` — provider-agnostic entry points: `getCustomer(org_uuid)`, `ensureCustomer(org_uuid)`, `listSubscriptions(org_uuid)`, `createSubscription(...)`, `updateSubscription(...)` (tier changes with proration), `cancelSubscription(...)` (immediate vs. end-of-period), `listInvoices(org_uuid)`. Every function takes `dbClient` first and returns the canonical envelope.
- [ ] `src/billing-stripe.ts` (or `src/billing-paddle.ts`) — concrete provider adapter. Pulled behind an interface so the provider choice is swappable. Exposes the raw provider API calls (`stripe.customers.create`, `stripe.subscriptions.update`, etc.) and the webhook signature verifier.
- [ ] `src/billing-webhook.ts` — processes inbound webhook events. Verifies signature; idempotency-keyed against `provider_event_id`; updates `subscriptions` / `invoices` rows; emits audit hooks. Must handle replays gracefully (Stripe retries up to 3 days).
- [ ] `src/usage.ts` — `recordUsageEvent(dbClient, app_uuid, org_uuid, user_uuid, metric, quantity, occurred_at, idempotency_key)`; rollup-recompute job called by `src/cron.ts`; helper to push the daily rollup to the provider as `usage_records` (Stripe metered-billing API).
- [ ] Extend `src/entitlements.ts → isLicensed` so subscription state participates in the licensing decision. The licensing chain becomes: if the app's `app_licensing_mode = 'none'`, licensed; otherwise an active or trialing subscription is required, with no grace for `past_due` / `canceled` / `paused`. Then fall through to the existing tier/floating-pool checks. A missing subscription row for a billed app means unlicensed — there is no implicit free tier.

## Endpoints (`functions/`)

- [ ] `functions/api/db/auth/organisations/[org_uuid]/billing/` — the org-facing billing tree. The current `org:billing` action in `src/permissions.ts` (held by `owner` and `billing`) splits into `org:billing:read` and `org:billing:write`. Roles `owner` and `billing` keep write; `admin` gains read so support-y admins can see invoices without having signing authority on payment methods.
  - `summary.ts` (GET) — current subscriptions, next billing date, outstanding balance.
  - `subscriptions/[subscription_uuid]/{update,cancel}.ts` (POST) — change tier, cancel.
  - `payment-methods/{list,add,remove,set-default}.ts` — payment-method management (or a redirect to the provider-hosted portal, depending on the provider).
  - `invoices/{list,one}.ts` — list invoices, fetch hosted-invoice URL.
- [ ] `functions/api/db/auth/organisations/[org_uuid]/apps/[app_uuid]/subscribe.ts` (POST) — self-serve subscribe. Validates the app is purchasable in the org's region, creates the customer if needed, creates the subscription (handing the user off to the provider-hosted checkout for payment-method capture).
- [ ] `functions/api/billing/_middleware.ts` — DB-connection middleware modelled on `functions/oauth/_middleware.ts`: opens a Hyperdrive `pg` client, no cross-origin guard, no session auth. The `/api/db/` cross-origin write guard does not apply to `/api/billing/*` because the guard lives in `functions/api/db/_middleware.ts` and only runs for routes under that subtree (the same reason `/oauth/*` and `/api/csp-report` are unaffected). Stripe webhooks send neither `Sec-Fetch-Site` nor `Origin`, so even if they were placed under `/api/db/` the guard would let them through (non-browser clients are explicitly allowed), but keeping billing siblings to `/oauth/` is the cleaner pattern.
- [ ] `functions/api/billing/webhook.ts` — provider webhook receiver. POST-only. Verifies the provider's signature header before doing any DB work; idempotency-keyed against `provider_event_id`. Authenticated entirely by the signature — no user session, no app credentials.
- [ ] `functions/api/billing/usage/[app_uuid].ts` (POST) — apps push usage events here. **Authenticated by app credentials** (the same `client_id` + `client_secret` they use for OAuth — reuse `verifyAppCredentials` from `src/apps.ts`); not by user session. Validates the org_uuid belongs to the app's subscription set; idempotency-keyed.
- [ ] **Operator endpoints** (gated by the operator allowlist that Phase 7 noted is still TBD): list subscriptions across all orgs, issue manual invoices, comp seats, refund / void invoices. Likely lives under `functions/api/db/auth/admin/billing/`.

## Frontend (`public/`)

- [ ] `public/account.html` — extend the Organisations section so each org list-row links to its billing page if the user holds `org:billing:read`.
- [ ] `functions/organisations/[org_uuid]/billing.ts` — server-rendered billing page (a Pages Function, like the existing `[org_uuid].ts`). Sections: current subscriptions (one card per app), upcoming invoice, payment method, billing history.
- [ ] Self-serve subscription flow: from the entitlements view on the app page, a "Subscribe" button when no active subscription exists. Hands off to provider-hosted checkout, returns via a success/cancel landing page.

## Subscription lifecycle

```
trialing → active → past_due → canceled
                 → paused
                 → active (resubscribed)
```

- [ ] **Trial start.** `trial_end` is set from `apps.app_default_trial_days` (or zero). During trial, `isLicensed` returns true; entitlements resolve normally.
- [ ] **Active.** Provider charges on the cycle (monthly/annual). Webhook `invoice.payment_succeeded` → mark invoice paid.
- [ ] **Past due.** Billing is **payment-up-front**: each period is charged before access is granted, and there is no grace window. A failed renewal charge moves the subscription to `past_due` and `isLicensed` flips to false the same moment. Warning emails go to `billing`-role members in the days leading up to the renewal attempt and immediately on failure; there is no day-of-cutoff email because the cutoff is the failure itself.
- [ ] **Canceled.** Provider-initiated (failed payment exhausted retries) or user-initiated (`cancel_at_period_end`). At `cancel_at`, `isLicensed` returns false. Entitlement rows stay in place — the operator can choose to keep "remembered" tiers / perms for a re-subscription, since they're already inert without an active subscription.
- [ ] **Paused.** Optional. Mirrors Stripe's pause-collection feature. Subscription stays open; no invoices issued; `isLicensed` returns false until resumed.
- [ ] **Resume / upgrade / downgrade.** All routed through the provider's API; webhook brings state back. Proration semantics inherit the provider's defaults; expose the "always charge immediately on upgrade" option in the org UI.

## Usage metering

For `usage`-mode apps:

- [ ] **Apps push events** to `POST /api/billing/usage/[app_uuid]`. Body shape: `{ org_uuid, user_uuid?, metric, quantity, occurred_at, idempotency_key }`. Authenticated by app credentials (HTTP Basic, same as `/oauth/token`).
- [ ] **Idempotency** is enforced by the unique `(app_uuid, idempotency_key)` constraint — retries are safe.
- [ ] **Nightly rollup** (a new entry in `src/cron.ts` on the daily schedule) aggregates `usage_events` → `usage_rollups`. The rollup is idempotent: recomputing a day from scratch produces the same row, so a failed run can be retried.
- [ ] **Provider sync.** The rollup job pushes the day's totals to Stripe via `subscriptionItem.createUsageRecord(...)`. Marked-as-synced state lives in `usage_rollups.synced_at`. Crashed/retried syncs don't double-bill because Stripe usage records accept an idempotency key.
- [ ] **Operator dashboard** — admin endpoint that shows usage rollups per org per app. Useful for support and dispute resolution.

## Audit hooks

New event types in `src/hooks/events.ts`. All severity `notice` unless flagged.

- [ ] `billing.customer.created`
- [ ] `billing.subscription.created`, `.updated` (tier change), `.canceled`, `.paused`, `.resumed` — severity `notice`; `.canceled` upgraded to `alert`.
- [ ] `billing.payment.succeeded`, `.failed` — `.failed` is `warning`; repeated `.failed` events for the same subscription escalate to `alert`.
- [ ] `billing.invoice.issued`, `.paid`, `.voided`.
- [ ] `billing.usage.recorded` — severity `debug` to keep volume manageable; the audit log isn't the metering store.

Webhook handlers emit these as part of the synchronisation; org-UI actions emit them at the call site like every other endpoint.

## Operations

- [ ] **`docs/Operations.md` additions:** pre-renewal warning email cadence, reading the billing-audit timeline, manual refund procedure, comp-seat procedure, switching payment provider.
- [ ] **`docs/Deployment.md` additions:** pushing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SIGNING_SECRET` as Wrangler secrets; setting the webhook endpoint URL in the Stripe dashboard to `${APP_URL}/api/billing/webhook`; setting up tax registration (or onboarding to Paddle MoR); per-app product/price configuration.
- [ ] **`docs/Architecture.md` additions:** the billing flow diagram (subscribe → checkout → webhook → entitlement state); new env vars; the webhook endpoint's exemption from the cross-origin write guard.
- [ ] **Refund handling.** Refunds flip an invoice to `void` but **do not** retroactively revoke entitlements — too much downstream chaos. Discuss case-by-case via the operator dashboard.
- [ ] **Compliance.** PCI is delegated entirely to the payment provider (card data never touches Puff). GDPR: invoices and customer records are user-identifiable; a `deleteUser` does not cascade to billing data — those rows stay because the org owns them, not the user. A `deleteOrganisation` should refuse if there's an outstanding balance.

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
