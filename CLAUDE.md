# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev               # build, then wrangler dev (local server)
npm run build             # wrangler pages functions build -> dist/worker/
npm run deploy            # build, then wrangler deploy
npm run typecheck         # tsc --noEmit (strict)
npm run typecheck:strict  # tsc with every extra strictness flag on
npm run lint              # prettier --check + typecheck
npm run format            # prettier --write
npm test                  # vitest run (unit tests)
npm run test:watch        # vitest in watch mode
npx wrangler types        # regenerate worker-configuration.d.ts (runs in prebuild)
```

`npm run lint` is the gate before pushing; CI runs Prettier and the build.

Unit tests live in `test/`, one `*.test.ts` file per `src/` module, run with [Vitest](https://vitest.dev). They run in plain Node and never open a real database: `src/` functions take `dbClient` as their first parameter, so tests pass a fake `pg` client (`test/helpers/fake-db.ts`) that scripts query responses by SQL match. `test/helpers/fake-env.ts` builds a minimal `Env`. `test/**/*.ts` is in the `tsconfig` `include`, so `npm run typecheck` covers tests too.

## Build model

The project deploys as a **single Cloudflare Worker bundle**, but is authored with **Pages Functions** directory-routing conventions. The build step (`wrangler pages functions build`) is the Pages compiler; the deploy step (`wrangler deploy`) is the Workers path. `public/` is served as Workers Static Assets; `functions/` is compiled into the same bundle. `dist/worker/` is a build artifact — never edit it.

`wrangler.jsonc`'s `main` is **`worker.ts`**, not the compiled bundle. The Pages compiler emits only a `fetch` handler; `worker.ts` is a thin entry that forwards `fetch` to the compiled `dist/worker/index.js` and adds the `scheduled` handler (Cron Triggers — see `src/cron.ts`). It sits outside the `tsconfig.json` `include` globs on purpose, because it imports the post-build artifact.

Node built-ins are marked `--external` in the build script (see `package.json`); `nodejs_compat` provides them at runtime. `compatibility_date` lives in both `wrangler.jsonc` and the build script.

## Architecture

A serverless SSO / access-control app. Stack: Cloudflare Workers + Pages Functions, CockroachDB (Postgres-compatible) via Cloudflare Hyperdrive, `pg` client, `otplib` for TOTP. The frontend is static HTML driven entirely by HTMX — there is no custom client-side JS, and **API endpoints return HTML fragments, not JSON**.

### Request layering

API endpoints live at flat paths under `functions/api/` (e.g. `functions/api/email/list.ts`, `functions/api/user/login.ts`). Routing is **not** by directory depth: a single `functions/api/_middleware.ts` composes the shared tier functions from `src/utilities/` and selects them per request via a route-policy table (`policyFor`). The composed chain is `[corsGate, maybeDb, maybeAuth, maybeOperator]`; each gate either runs its tier function or passes through, based on the policy for the request path:

- **CORS** — `corsGate` always runs. First-party HTMX paths get the internal `sameOriginWriteGuard` (anti-CSRF: state-changing methods must be same-origin). `/api/billing/*` gets the external `externalCorsGuard` (real CORS for third-party, signature/token-authed callers).
- **DB** (`createDbMiddleware`) — opens a Hyperdrive `pg` client into `context.data.dbClient`, closes it in `finally`.
- **Auth** (`sessionAuthMiddleware`) — reads the `session_token` cookie, verifies it, sets `context.data.user_uuid`.
- **Operator** (`operatorAuthMiddleware`) — gates the `/api/admin/*` prefix to UUIDs in `OPERATOR_USER_UUIDS`.

The policy is **fail-safe by default**: any `/api/*` path not listed in the `NO_DB` / `PUBLIC_DB` exact-path sets (or matched by the `/api/billing/` and `/api/admin/` prefixes) gets `{ db: true, auth: true }` — the most-protected tier. A new endpoint someone forgets to register is locked down, not exposed. The tiers compose in order, so auth implies db and operator implies auth; each gate's prerequisite is always satisfied.

Endpoints read `context.data.dbClient` / `context.data.user_uuid` directly — never re-connect or re-authenticate in a handler.

The three resource-scoped middlewares under `functions/api/organisations/[org_uuid]/` (plus `.../apps/[app_uuid]/` and `.../teams/[team_uuid]/`) are **not** part of the tier model: they run *after* the policy middleware to resolve per-resource membership/roles for that subtree's authz, and are described in the backend instructions.

### `src/` domain modules

`src/` holds backend logic with no HTTP handling, one module per domain (`users`, `sessions`, `passwords`, `emails`, `tokens`, `2fa`, plus `src/utilities/`). Every `src/` function takes `dbClient` as its first parameter and returns a structured envelope (`{ success: true, ... }` / `{ error: true, ... }` / `{ exists: boolean }`) — they do not throw or return raw rows. The sole exception is `user_register`, which throws (wrap calls in try/catch).

`src/cron.ts` is a deliberate departure: it runs on a Cron Trigger with no `_middleware.ts` in front of it. Today it only carries work that has to stay in the Worker — OAuth signing-key rotation (`src/oauth-keys-rotation.ts`), on a daily cron that rotates the key once a week. Pure-SQL cleanup (session / token / TOTP / floating-session / audit purges) runs **in the database** via CockroachDB Row-Level TTL declared in `sql/schedules.sql`. `runScheduledCleanup` in `src/cron.ts` is retained as a manually-callable fallback.

### Database

Schema is in `sql/`, one file per table; `sql/schedules.sql` (CockroachDB v23.1+) sets the Row-Level TTL cleanup rules and applies last. Import in foreign-key order: `users.sql` first, then `organisations.sql` → `teams.sql` → `organisation_members.sql` / `team_members.sql` / `organisation_invitations.sql`; `apps.sql` has no FK dependencies (linked apps are globally registered by the operator, not org-owned) and can be imported any time after `users.sql`; then the KV tables (`user_key_values.sql` / `team_key_values.sql` / `organisation_key_values.sql` / `org_role_key_values.sql` / `team_role_key_values.sql` / `app_key_values.sql`) which depend on `users` + `organisations` + (where the subject or owner is an app) `apps`; then `oauth_grants.sql` / `oauth_consents.sql`, both depending on `users` and `apps` (and `oauth_grants` also FKs `organisations` for the org-context binding); `app_floating_sessions.sql`, which depends on `apps` + `organisations` + `users`; `external_identities.sql` (federated/social login), which depends on `users`; `federated_signup_tokens.sql` and `audit_events.sql` have no FK dependencies (audit rows are deliberately FK-less so they outlive their referents — see `docs/Operations.md → Audit events & hooks`); every other table depends only on `users`. The `secrets` table stores both passwords and TOTP secrets, keyed by `secret_type`; the `tokens` table stores all temporary tokens, keyed by `token_type`. All queries are parameterized (`$1, $2`). Multi-step writes use explicit `BEGIN/COMMIT/ROLLBACK` transactions.

## Detailed conventions

This repo has detailed, scoped instruction docs — consult them before non-trivial work:

- `docs/Architecture.md` — codebase shape, request layering, libraries, OAuth endpoints, environment variables.
- `docs/Hierarchy.md` — data model: Apps, Organisations, Teams, Roles, Users; KV resolver chain; entitlements.
- `docs/Development.md` — local-machine setup, tests, linting.
- `docs/Deployment.md` — production deploy, step-by-step.
- `docs/Operations.md` — cron, audit log, OAuth key rotation, registering apps and providers, security concerns.
- `.github/instructions/architecture.instructions.md` — routing, middleware, HTMX response headers.
- `.github/instructions/backend.instructions.md` — `src/` envelope shapes, endpoint handler patterns, cookie assembly.
- `.github/instructions/database.instructions.md` — query/transaction/conflict-handling conventions.
- `.github/instructions/frontend.instructions.md` — HTMX form patterns, CSS classes, page list.
- `.github/instructions/security.instructions.md` — sessions, password hashing, 2FA, token expiries, enumeration prevention.

## Endpoint conventions (quick reference)

- Export `onRequestGet` / `onRequestPost` for supported methods, plus a catch-all `onRequest` returning 405 with an accurate `Allow` header.
- Validate all input at the top of the handler, before any DB or business-logic call.
- Success/error responses are HTML fragments with `class="result-positive"` / `class="result-negative"`.
- Use `HX-Redirect` for HTMX navigation, plain `Location` for direct browser navigation (branch on the `HX-Request` header); use `HX-Trigger` to refresh other page sections.
- Reflecting user input into HTML must go through `escapeHtml` from `src/utilities/escape.ts`.
- Auth-cookie `Secure` / `SameSite` are driven by env vars (`SECURE_COOKIE`, `COOKIE_SAMESITE`) — never hardcode them.
- Outbound `fetch()` to third-party APIs follows the patterns in `.github/instructions/backend.instructions.md → External API calls`: `cf.cacheTtl` for cacheable lookups (HIBP), `context.waitUntil` for fire-and-forget where the response is generic (most email sends), plain `await` only when the result shapes the user-facing reply.

## Production blocker

Verification and password-reset links are currently `console.log`'d server-side as a placeholder for email delivery. The two sites are marked `// SECURITY: remove before production` (in `src/users.ts` and `functions/api/password/request.ts`) and must be removed before any production deployment.
