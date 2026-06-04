# Development

Local-machine setup for contributors. For the shape of the codebase see [Architecture.md](Architecture.md); for shipping to production see [Deployment.md](Deployment.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [First-time setup](#first-time-setup)
- [Running locally](#running-locally)
- [Local database](#local-database)
- [Local environment variables](#local-environment-variables)
- [Local OAuth signing key](#local-oauth-signing-key)
- [Local email](#local-email)
- [Local federated-login providers](#local-federated-login-providers)
- [Tests](#tests)
- [Linting and formatting](#linting-and-formatting)
- [Type checking and Wrangler types](#type-checking-and-wrangler-types)
- [CI](#ci)

## Prerequisites

- **Node.js 22+** (`wrangler` refuses to run on older versions). Use [`nvm`](https://github.com/nvm-sh/nvm) if you don't already have it pinned:

  ```sh
  nvm install stable
  nvm use stable
  ```

- A local PostgreSQL or CockroachDB instance, or a hosted one you can connect to from your machine. See [Local database](#local-database) below.

## First-time setup

```sh
git clone https://github.com/eustasy/puff-serverless
cd puff-serverless
npm ci
```

`npm ci` runs `prebuild` which calls `npx wrangler types` to regenerate `worker-configuration.d.ts`. That file is gitignored — you'll need to re-run it whenever `wrangler.jsonc` changes.

## Running locally

```sh
npm run dev
```

This builds the Pages-Functions bundle into `dist/worker/`, then starts `wrangler dev`. The server listens on `http://localhost:8788`. The frontend is HTMX — open the page in a browser and forms submit against the running endpoints.

For UI-only changes, the static files in `public/` are served directly; only changes to `functions/` or `src/` need a rebuild (Wrangler picks them up on save, but a full restart is sometimes faster).

## Local database

The simplest path is a local Postgres or [CockroachDB single-node demo](https://www.cockroachlabs.com/docs/stable/cockroach-demo). Import the schema in dependency order (see [Deployment.md → Provision and import](Deployment.md#1-provision-the-database) for the full ordered list).

The `HYPERDRIVE` binding in `wrangler.jsonc` points at a production Hyperdrive config that isn't reachable from `wrangler dev`. Override it locally by setting `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in `.env`:

```sh
# .env (git-ignored)
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/puff"
```

`wrangler dev` reads this and substitutes it for the binding's connection string. The deployed worker is unaffected.

## Local environment variables

`wrangler dev` reads `.env` (or `.dev.vars`) for variables that the deployed worker reads from `wrangler.jsonc` `vars` or from secrets. The full list of variables lives in [Architecture.md → Environment variables](Architecture.md#environment-variables); a minimal local `.env` looks like:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/puff"

APP_URL="http://localhost:8788"
APP_NAME="Puff (dev)"

MAILTRAP_TOKEN="<your sandbox token>"
MAILTRAP_SENDER="hello@demomailtrap.co"
MAILTRAP_API_URL="https://sandbox.api.mailtrap.io/api/send/<inbox_id>"

OAUTH_SIGNING_KEY_PRIVATE='{"kty":"EC","crv":"P-256","d":"…","x":"…","y":"…"}'
```

Never commit `.env`. It's listed in `.gitignore`.

## Local OAuth signing key

The OAuth provider needs a private signing key even in dev (the `/oauth/*` and `/.well-known/jwks.json` endpoints fail without it). Generate one with the included script:

```sh
node scripts/generate-oauth-key.mjs
```

It prints the private JWK as a single line, the matching public JWK with its `kid`, and the `wrangler secret put` command for production. For local dev, copy the private JWK into `.env` as `OAUTH_SIGNING_KEY_PRIVATE`.

Dev keys are not sensitive to rotate — generate a fresh one any time. Production rotation is a separate procedure; see [Operations.md → OAuth signing-key rotation](Operations.md#oauth-signing-key-rotation).

## Local email

Mailtrap offers a free **sandbox inbox** that accepts sends but never delivers — perfect for local development. Set `MAILTRAP_API_URL` to the sandbox URL (`https://sandbox.api.mailtrap.io/api/send/<inbox_id>`) instead of the live send endpoint and you can register users, request password resets, and accept invitations without spamming real mailboxes.

If `MAILTRAP_TOKEN` is unset, `src/mailer.ts` logs an error and returns a failure envelope rather than sending — the registration and reset flows continue to function (you'll see the failure message inline), but the link itself never gets delivered.

## Local federated-login providers

To test GitHub / Google / Microsoft sign-in locally, register a **separate** app at each provider with a redirect URI pointing at `http://localhost:8788/login/<provider>/callback` (the URI must match exactly — production and dev are different registrations). Push the credentials to `.env`:

```sh
OAUTH_GITHUB_CLIENT_ID="…"
OAUTH_GITHUB_CLIENT_SECRET="…"
OAUTH_GOOGLE_CLIENT_ID="…"
OAUTH_GOOGLE_CLIENT_SECRET="…"
OAUTH_MICROSOFT_CLIENT_ID="…"
OAUTH_MICROSOFT_CLIENT_SECRET="…"
```

A provider with both vars missing is treated as not configured and its `/login/<provider>` route 404s — that's fine, the buttons for unconfigured providers don't render. The full per-provider walkthrough is in [Operations.md → Adding a federated login provider](Operations.md#adding-a-federated-login-provider).

## Tests

```sh
npm test            # one-shot
npm run test:watch  # re-run on file change
```

Unit tests live in `test/`, one `*.test.ts` file per `src/` module, run with [Vitest](https://vitest.dev). They run in plain Node and never open a real database: `src/` functions take `dbClient` as their first parameter, so tests pass a fake `pg` client (`test/helpers/fake-db.ts`) that scripts query responses by SQL match. `test/helpers/fake-env.ts` builds a minimal `Env`. `test/**/*.ts` is in the `tsconfig` `include`, so `npm run typecheck` covers tests too.

Adding a new `src/` module? Mirror it with `test/<module>.test.ts`. Adding a new emit site for a hook? `test/hooks/` covers the dispatcher and the audit listener.

## Linting and formatting

```sh
npm run lint        # prettier --check + npm run typecheck
npm run format      # prettier --write
```

`npm run lint` is the gate before pushing; CI runs the same. Editors with a Prettier integration can format on save and skip the explicit `npm run format`.

## Type checking and Wrangler types

```sh
npm run typecheck         # tsc --noEmit (strict)
npm run typecheck:strict  # tsc with every extra strictness flag on
npx wrangler types        # regenerate worker-configuration.d.ts
```

`worker-configuration.d.ts` reflects the bindings declared in `wrangler.jsonc`. Re-run `npx wrangler types` after editing that file (`npm run dev` and `npm ci` both do this for you via `prebuild`).

## CI

CI runs Prettier and the build on every push. The relevant gate is `npm run lint`, which combines Prettier's check mode with `tsc --noEmit`. The vitest suite is not currently run in CI — keep tests local-only for now (they are quick: ~10 seconds for the whole suite).

Dependabot updates npm and GitHub Actions dependencies via automatic pull requests; see `.github/dependabot.yml`. The Cloudflare `compatibility_date` in `wrangler.jsonc` is a manual bump — review the [compatibility-dates changelog](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) when nudging it.
