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

Routing is by directory depth under `functions/api/`, with two middleware files gating each layer:

- `functions/api/` — no DB, no auth (e.g. `password/requirements.ts`).
- `functions/api/db/` — `_middleware.ts` opens a Hyperdrive `pg` client, sets `context.data.dbClient`, closes it in `finally`.
- `functions/api/db/auth/` — `_middleware.ts` reads the `session_token` cookie, verifies it, sets `context.data.user_uuid`.

Endpoints read `context.data.dbClient` / `context.data.user_uuid` directly — never re-connect or re-authenticate in a handler. DB middleware runs before auth middleware.

### `src/` domain modules

`src/` holds backend logic with no HTTP handling, one module per domain (`users`, `sessions`, `passwords`, `emails`, `tokens`, `2fa`, plus `src/utilities/`). Every `src/` function takes `dbClient` as its first parameter and returns a structured envelope (`{ success: true, ... }` / `{ error: true, ... }` / `{ exists: boolean }`) — they do not throw or return raw rows. The sole exception is `user_register`, which throws (wrap calls in try/catch).

`src/cron.ts` is a deliberate departure: it runs on a Cron Trigger with no `_middleware.ts` in front of it, so it opens and closes its own `pg` client rather than receiving one. It is the scheduled-cleanup job (purges old sessions/tokens and stale TOTP replay-guard rows).

### Database

Schema is in `sql/`, one file per table. Import in foreign-key order: `users.sql` first, then `organisations.sql` → `teams.sql` → `organisation_members.sql` / `team_members.sql`; every other table depends only on `users`. The `secrets` table stores both passwords and TOTP secrets, keyed by `secret_type`; the `tokens` table stores all temporary tokens, keyed by `token_type`. All queries are parameterized (`$1, $2`). Multi-step writes use explicit `BEGIN/COMMIT/ROLLBACK` transactions.

## Detailed conventions

This repo has detailed, scoped instruction docs — consult them before non-trivial work:

- `ARCHITECTURE.md` — deployment, env vars, table-usage reference.
- `.github/instructions/architecture.instructions.md` — routing, middleware, HTMX response headers.
- `.github/instructions/backend.instructions.md` — `src/` envelope shapes, endpoint handler patterns, cookie assembly.
- `.github/instructions/database.instructions.md` — query/transaction/conflict-handling conventions.
- `.github/instructions/frontend.instructions.md` — HTMX form patterns, CSS classes, page list.
- `.github/instructions/security.instructions.md` — sessions, password hashing, 2FA, token expiries, enumeration prevention.

Note: those instruction docs were written against an earlier `.js` codebase; the actual source files are now `.ts`. The patterns still apply — only the extensions differ.

## Endpoint conventions (quick reference)

- Export `onRequestGet` / `onRequestPost` for supported methods, plus a catch-all `onRequest` returning 405 with an accurate `Allow` header.
- Validate all input at the top of the handler, before any DB or business-logic call.
- Success/error responses are HTML fragments with `class="result-positive"` / `class="result-negative"`.
- Use `HX-Redirect` for HTMX navigation, plain `Location` for direct browser navigation (branch on the `HX-Request` header); use `HX-Trigger` to refresh other page sections.
- Reflecting user input into HTML must go through `escapeHtml` from `src/utilities/escape.ts`.
- Auth-cookie `Secure` / `SameSite` are driven by env vars (`SECURE_COOKIE`, `COOKIE_SAMESITE`) — never hardcode them.

## Production blocker

Verification and password-reset links are currently `console.log`'d server-side as a placeholder for email delivery. The two sites are marked `// SECURITY: remove before production` (in `src/users.ts` and `functions/api/db/password/request.ts`) and must be removed before any production deployment.
