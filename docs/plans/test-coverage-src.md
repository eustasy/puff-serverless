# Test Coverage: `src/` to ~100%

Plan to raise unit-test coverage of the `src/` domain layer from its current
**64.97% of lines** toward 100%. Baseline captured 2026-06-05 via
`vitest run --coverage` (`@vitest/coverage-v8`, config in `vitest.config.ts`).

The deficit is **981 uncovered lines out of 2801**. The headline finding is that
**roughly half the gap (486 lines) is in 20 modules that have no test file at
all** — not in hard-to-reach branches. Every one of those modules is reachable
with the *existing* plain-Node + `FakeDb` harness; none needs
`@cloudflare/vitest-pool-workers`. So most of the work is mechanical: write the
missing `*.test.ts` files using patterns this repo already uses elsewhere.

## Table of Contents

- [Baseline](#baseline)
- [Why this is mostly mechanical](#why-this-is-mostly-mechanical)
- [The four mock patterns (all already in the repo)](#the-four-mock-patterns-all-already-in-the-repo)
- [Tier 0 — shared `fake-context` helper](#tier-0--shared-fake-context-helper)
- [Tier 1 — untested modules → new test files (~486 lines)](#tier-1--untested-modules--new-test-files-486-lines)
- [Tier 2 — fill the big holes in partially-covered modules (~320 lines)](#tier-2--fill-the-big-holes-in-partially-covered-modules-320-lines)
- [Tier 3 — the long tail (~175 lines)](#tier-3--the-long-tail-175-lines)
- [What we will NOT chase](#what-we-will-not-chase)
- [Locking the gains in (coverage ratchet)](#locking-the-gains-in-coverage-ratchet)
- [Execution order & expected coverage after each tier](#execution-order--expected-coverage-after-each-tier)

## Baseline

```
TOTAL lines: 1820/2801 = 64.97%   (981 missed)
Statements : 63.87%   Branches : 50.51%   Functions : 74.67%
```

By directory:

| Area              | Lines  | Note                                                    |
| ----------------- | ------ | ------------------------------------------------------- |
| `src/`            | 74.02% | domain modules — partial gaps                            |
| `src/utilities/`  | 35.82% | **the main drag** — 14 of 31 files at 0%                 |
| `src/hooks/`      | 100%   | done                                                     |

## Why this is mostly mechanical

`src/` is authored so every function takes `dbClient` first and returns a
structured envelope (`{ success }` / `{ error }` / `{ exists }`) — they don't
throw and don't touch HTTP. The few "endpoint helper" files in `src/utilities/`
(e.g. `entitlements-endpoint.ts`) are handler **factories** that take a
`context`-shaped object; that object is a plain JS value we can construct in a
test. We confirmed by reading the untested files that nothing requires a live
Worker runtime:

- `oauth-claims.ts`, `oauth-token.ts` — `dbClient` + pure composition.
- `oauth-outbound.ts` — only `fetch` (global, stubbable).
- `responses.ts`, `session-cookie.ts`, `error-page.ts`, `operator-uuids.ts` — pure functions returning strings / `Response`.
- `entitlements-endpoint.ts`, `keyvalues-endpoint.ts`, `members-endpoint.ts`, `oauth-authorize.ts`, `oauth-token-grants.ts`, `oauth-userinfo.ts` — handler factories taking a fake `context`.
- `db-middleware.ts` — `new Client()` from `pg`; the error branches are testable, the happy path via a mocked `pg` (precedent: `cron.test.ts`).

## The four mock patterns (all already in the repo)

Every untested file maps to one of these, and each has a working precedent — no
new infrastructure required:

1. **`FakeDb`** (`test/helpers/fake-db.ts`) — `db.on(/SELECT .../, { rows })`,
   `db.once(...)` for retry sequences, `pgError("40001")` for SQLSTATE branches.
   Used by ~40 existing tests.
2. **`vi.stubGlobal("fetch", fetchMock)`** — precedent in `test/mailer.test.ts`
   and `test/passwords.test.ts` (HIBP). Covers `oauth-outbound.ts` and the
   Stripe-provider `fetch` paths.
3. **Fake `context` object** — precedent in `test/hooks/dispatch.test.ts`:
   `{ data: { dbClient: new FakeDb().client, user_uuid }, ... }`. Extend with
   `params`, `request: new Request(...)`, `env`, `next`, `waitUntil` for the
   endpoint-factory files.
4. **Mocked `pg` `Client`** — precedent in `test/cron.test.ts` /
   `test/oauth-keys-rotation.test.ts` (`vi.mock("pg", ...)` with
   `queryMock`/`connectMock`/`endMock`). Covers `db-middleware.ts` and the rest
   of `cron.ts`.

Convention to keep: **one `*.test.ts` per `src/` module**, mirroring the path
(`src/utilities/foo.ts` → `test/utilities/foo.test.ts`). `test/**/*.ts` is in the
`tsconfig` include, so new tests are typechecked too.

## Tier 0 — shared `fake-context` helper

Before Tier 1, add `test/helpers/fake-context.ts`: a small builder returning a
fake Pages `EventContext` (`data`, `params`, `request`, `env`, `next`,
`waitUntil`, `passThroughOnException`) with overridable fields. Six Tier-1 files
plus several Tier-2 endpoint paths need it; a shared builder keeps them
consistent and avoids re-deriving the shape per test. Model it on the inline
object in `test/hooks/dispatch.test.ts`.

## Tier 1 — untested modules → new test files (~486 lines)

20 modules with **zero** coverage. Ordered by lines recovered. This tier alone
moves the total from ~65% to ~81%.

### 1a — pure functions / trivial (fast, do first)

| File | Missed | Test approach |
| ---- | ------ | ------------- |
| `utilities/session-cookie.ts` | 12 | assert cookie string parts for both `SECURE_COOKIE`/`COOKIE_SAMESITE` on and off; `unauthorizedResponse` HTMX (`HX-Redirect`) vs direct (401 body) branch. |
| `utilities/responses.ts` | 5 | `resultPositive`/`resultNegative` status + escaped body; `methodNotAllowed` `Allow` header. |
| `utilities/error-page.ts` | 4 | rendered HTML + status. |
| `utilities/federated-signup.ts` | 5 | small pure helper. |
| `utilities/login-provider-callback.ts` | 4 | small pure helper. |
| `utilities/operator-uuids.ts` | 3 | constant/parse helper. |
| `utilities/2fa-bypass-request.ts` | 1 | single export. |
| `utilities/admin-schedules.ts` | 1 | single export. |

### 1b — crypto / cookie helpers

| File | Missed | Test approach |
| ---- | ------ | ------------- |
| `utilities/oauth-state-cookie.ts` | 24 | build state cookie + PKCE challenge (Web Crypto is a Node 22 global, as in `hashing.test.ts`); round-trip parse; tamper/expiry rejection. |
| `utilities/csp-report.ts` | 7 | POST a report body via `new Request`, assert 204/parse; malformed-body branch. |

### 1c — `dbClient` composition

| File | Missed | Test approach |
| ---- | ------ | ------------- |
| `oauth-claims.ts` | 30 | `FakeDb`: scripts for `listOrganisationsForUser` + `team_members` join. Assert memberships filter disabled orgs, roles group by org/team, entitlements null when `org_uuid` null; the three `catch` branches via `pgError`. |
| `utilities/oauth-token.ts` | 44 | `buildIdToken`/`buildAccessToken` with `fakeEnv` signing keys (reuse `oauth-jwt.test.ts` key setup) + `FakeDb` for `readUser`/`readEmails`; `parseBasicAuth` good/garbled inputs; `tokenResponse` no-store headers; `openid`-absent → null. |

### 1d — `fetch`-driven

| File | Missed | Test approach |
| ---- | ------ | ------------- |
| `oauth-outbound.ts` | 43 | `vi.stubGlobal("fetch", ...)` per `mailer.test.ts`. `buildAuthorizeUrl` query params; `exchangeCode` success / non-OK (502) / missing token / network throw; `fetchUserIdentity` userinfo OK, GitHub emails companion, unrecognisable profile, network throw. |

### 1e — handler factories (need Tier-0 `fake-context`)

| File | Missed | Test approach |
| ---- | ------ | ------------- |
| `utilities/oauth-authorize.ts` | 73 | drive the authorize handler with fake `context` + `FakeDb`: missing/invalid params, unknown client, scope validation, consent-required vs auto-approve, redirect assembly. Largest single file — budget accordingly. |
| `utilities/oauth-token-grants.ts` | 66 | each grant type (auth code, refresh, client credentials) success + failure; reuse `oauth-token.ts` builders. |
| `utilities/entitlements-endpoint.ts` | 63 | `validateEntitlementKey` accept/reject; the three factory handlers (`list`/`set`/`remove` × team/user) for 403 (no `can`), `assertGranteeInOrg` failure, success + `HX-Trigger`, `methodNotAllowed`. |
| `utilities/oauth-userinfo.ts` | 39 | bearer parse, scope-gated claim inclusion, invalid token → 401. |
| `utilities/keyvalues-endpoint.ts` | 33 | `parseSetForm`/`parseKeyForm` validation; `renderKeyValueTable` markup; factory handlers. |
| `utilities/members-endpoint.ts` | 13 | shared member-listing factory: success + permission failure. |
| `utilities/db-middleware.ts` | 16 | missing `HYPERDRIVE` binding → 503; connect-throw → 500; happy path + `finally` `end()` via `vi.mock("pg")` (precedent: `cron.test.ts`). |

## Tier 2 — fill the big holes in partially-covered modules (~320 lines)

Extend the **existing** test files. Moves ~81% → ~91%.

| File | Missed | Uncovered surface |
| ---- | ------ | ----------------- |
| `cron.ts` | 56 | `scheduled` dispatch, `runScheduledWork`, `runBillingEmailReconcile`, `runDailyUsageRollup` (lines 54–172). Use the mocked-`pg` pattern already in `cron.test.ts`. |
| `passwords.ts` | 54 | `verifyPassword` algo/upgrade branches; `isPasswordReused`; `passwordRequirementsHtml` (445–508, the HTML-assembly per-rule branches). |
| `billing-stripe.ts` | 48 | `mapStripeSubscription` field mapping; `verifyStripeSignature` valid/invalid/expired; `createStripeProvider` fetch paths (stub `fetch`). |
| `billing.ts` | 43 | error/edge branches in the larger flows (731 LoC file — target the uncovered envelope failure paths). |
| `2fa.ts` | 39 | `enable2fa`, `used2fa`, `verifyTotpLogin` (90–191, 243–296): wrong code, replay, missing secret, token expiry. |
| `emails.ts` | 24 | uncovered add/verify/primary-swap failure branches. |
| `users.ts` | 20 | remaining branches incl. the `user_register` throw path (the one function that throws). |
| `billing-webhook.ts` | 18 | unhandled event types, signature-fail, idempotency branch (lines 111–131, 205–219). |
| `entitlements.ts` | 18 | resolver edge cases (396–397, 465–466) + `assertGranteeInOrg` failures. |

## Tier 3 — the long tail (~175 lines)

Small per-file gaps in already-healthy modules. Mostly defensive `catch`
branches and rare conflict paths. Moves ~91% → ~96%. Add cases opportunistically
while touching neighbours:

`oauth-keys-rotation.ts` (15), `memberships.ts` (14), `app-floating-sessions.ts`
(13), `apps.ts` (13), `sessions.ts` (12), `external-identities.ts` (11),
`invitations.ts` (10), `oauth-grants.ts` (10), `tokens.ts` (10),
`keyvalues-shared.ts` (8), `passkeys.ts` (7), `usage.ts` (7),
`oauth-consents.ts` (6), `oauth-keys.ts` (5), `federated-signup-tokens.ts` (4),
`organisations.ts` (4), `teams.ts` (4), `named-entity.ts` (4),
`role-keyvalues-shared.ts` (4), `oauth-jwt.ts` (3), `base64url.ts` (3),
`login-response.ts` (2), `keyvalues-resolver.ts` (2), `oauth-providers.ts` (1),
`hashing.ts` (1), `headers.ts` (1), `validation.ts` (1).

## What we will NOT chase

True 100% is a poor target here. The residual after Tier 3 is dominated by
**defensive branches that can't be hit without contorting the test** — `catch`
blocks that only fire on driver-level failures, `console.error` lines, and
`|| default` fallbacks for env vars. Where a branch is genuinely unreachable in
unit context, annotate it with a `/* v8 ignore next */` comment **and a reason**
rather than writing a contrived test. The goal is **≥95% lines / ≥90% branches**
with the remainder explicitly justified — not a vanity 100%.

## Locking the gains in (coverage ratchet)

CI already emits `coverage/lcov.info` for the Qlty upload. To stop regressions,
add a `coverage.thresholds` block to `vitest.config.ts` once Tier 2 lands
(e.g. start at the then-current numbers, ratchet up per tier):

```ts
coverage: {
  // ...existing...
  thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
}
```

`vitest run --coverage` then fails below threshold. Raise the numbers as Tier 3
progresses so the floor only ever rises.

## Execution order & expected coverage after each tier

| Step | Work | Lines recovered | Total lines | Notes |
| ---- | ---- | --------------- | ----------- | ----- |
| Tier 0 | `fake-context.ts` helper | 0 | 64.97% | enabler |
| Tier 1 | 20 new test files | ~+440 | **~81%** | half the gap; do 1a→1e |
| Tier 2 | extend 9 test files | ~+275 | **~91%** | add ratchet at end |
| Tier 3 | long-tail branches | ~+140 | **~96%** | + `v8 ignore` annotations |

Gate after every file: `npm test` green, then `npm run lint` (Prettier +
`tsc`). Re-run `vitest run --coverage` at each tier boundary to confirm the
projected jump and re-sort the remaining long tail by actual missed lines.
