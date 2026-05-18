# Architecture

## Table of Contents

- [Deployment](#deployment)
  - [First time project setup](#first-time-project-setup)
  - [Continuous Development](#continuous-development)
  - [Deploying to Production](#deploying-to-production)
  - [Scheduled cleanup](#scheduled-cleanup)
  - [Directories](#directories)
  - [Special Files](#special-files)
- [Libraries](#libraries)
- [APIs](#apis)
- [Environment Variables](#environment-variables)
- [Database Schema Changes](#database-schema-changes)
- [Project Maintenance](#project-maintenance)

## Deployment

### First time project setup

#### Node & NPM

Use the latest Node version. We recommend you [Install NVM](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating) if you are not already using Node.

```sh
nvm install stable
nvm use stable
```

#### Postgres or CockroachDB

_Note: SQL Schema can be found in the SQL folder, one file per table. `users.sql` should be imported first as it provides the foreign key for many other tables._

##### for Local Development

You can override the Hyperdrive connection strings by setting the following in `.env`:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/databasename"
```

##### for Production Deployment

Production uses [CockroachDB Cloud](https://www.cockroachlabs.com/) (or any Postgres-compatible database) reached through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), which pools connections at the edge.

1. Provision the database and import the schema from `sql/` — **`users.sql` first** (it provides the foreign key the other tables depend on).
2. Create a Hyperdrive configuration pointing at it:

   ```sh
   npx wrangler hyperdrive create puff-serverless --connection-string="postgres://user:password@host:26257/puff?sslmode=verify-full"
   ```

3. Copy the returned Hyperdrive ID into `wrangler.jsonc` under `hyperdrive[].id` (binding name `HYPERDRIVE`).

The `HYPERDRIVE` binding is what `functions/api/db/_middleware.ts` opens its `pg` client against. Local development bypasses the deployed Hyperdrive config via `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (see above), so the same `wrangler.jsonc` works in both environments.

### Continuous Development

```sh
npm ci
npm run dev
```

Before pushing you may wish to run linting or allow autoformatting to run, or configure your editor to automatically use prettier.

```sh
npm run lint
npm run format
```

You may also need to update types:

```sh
npx wrangler types
```

### Deploying to Production

Deployment uses `wrangler deploy` — the Workers path (see [Directories](#directories) for why the build step still uses the Pages Functions compiler). Node.js v22+ is required; `wrangler` refuses to run on older versions.

1. **Authenticate Wrangler** (once per machine):

   ```sh
   npx wrangler login
   ```

2. **Set secrets.** Secrets are encrypted by Cloudflare and never committed to the repo:

   ```sh
   npx wrangler secret put MAILTRAP_TOKEN
   ```

3. **Set variables.** Confirm the `vars` block in `wrangler.jsonc` (`MAILTRAP_SENDER`, `MAILTRAP_SENDER_NAME`, `APP_URL`) holds production values, and set the operational variables from the [Environment Variables](#environment-variables) table. In particular, `SECURE_COOKIE` should be truthy in production so auth cookies are restricted to HTTPS, and `APP_URL` must be the public origin so email links resolve.

4. **Deploy:**

   ```sh
   npm run deploy
   ```

   This builds the bundle (`wrangler pages functions build`) and then runs `wrangler deploy`.

5. **Custom domain.** By default the Worker is served at `puff-serverless.<account>.workers.dev`. To serve it at its public origin, add a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) for the Worker (via the Cloudflare dashboard, or a `routes` entry in `wrangler.jsonc`), and keep `APP_URL` in sync with it.

The Cron Triggers (see [Scheduled cleanup](#scheduled-cleanup)) are declared in `wrangler.jsonc` and registered automatically by `wrangler deploy` — no extra step.

### Scheduled cleanup

The request path only ever _soft_-expires data: sessions are marked inactive, tokens marked used, TOTP codes recorded — nothing is deleted inline. A [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) reaps that data instead.

The schedules are declared as `triggers.crons` in `wrangler.jsonc`; the `scheduled` handler is added by `worker.ts` and the job itself is `src/cron.ts`. That module is the one DB caller with no `_middleware.ts` in front of it, so it opens and closes its own `pg` client.

| Schedule      | Action                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*/5 * * * *` | Purge `totp_used_codes` rows past the TOTP acceptance window. Runs often so a stale row cannot collide with a later, legitimately-different code. |
| `0 * * * *`   | Additionally purge `sessions` and `tokens` older than one month. They are kept that long first — a defunct row is a lightweight audit record.     |

Sessions are purged only when also defunct (inactive or past expiry), so a still-valid session is never deleted even if `SESSION_MAX_AGE_SECONDS` is raised beyond a month.

### Directories

The project deploys as a single Cloudflare Worker bundle. The Worker serves static files from `public/` via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), and the dynamic endpoints under `functions/` are compiled into the same bundle using Pages Functions directory-routing conventions. The build step is `wrangler pages functions build` (the Pages Functions compiler) but the deploy command is `wrangler deploy` — the Workers path.

| Folder                                                                                      | Contents                                                                                              | Role                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| [public](https://github.com/eustasy/puff-serverless/tree/main/public)                       | All static files: HTML (e.g., `index.html`, `login.html`), CSS, Client-Side JS (e.g., `htmx.min.js`). | Workers Static Assets |
| [functions](https://github.com/eustasy/puff-serverless/tree/main/functions)                 | Dynamic endpoints: pages that must load with pre-inserted data.                                       | Bundled into Worker   |
| [functions/api](https://github.com/eustasy/puff-serverless/tree/main/functions/api)         | API Endpoints that only require server-side JavaScript.                                               | Bundled into Worker   |
| [functions/api/db](https://github.com/eustasy/puff-serverless/tree/main/functions/api)      | API Endpoints that require database access.                                                           | Bundled into Worker   |
| [functions/api/db/auth](https://github.com/eustasy/puff-serverless/tree/main/functions/api) | API Endpoints that require authentication.                                                            | Bundled into Worker   |
| [src](https://github.com/eustasy/puff-serverless/tree/main/src)                             | Backend logic, organized by domain (e.g., `users.js`, `sessions.js`, `2fa.js`).                       | Bundled into Worker   |
| [src/utilities](https://github.com/eustasy/puff-serverless/tree/main/src/utilities)         | Utility functions (e.g., `hashing.js`, `headers.js`).                                                 | Bundled into Worker   |
| [sql](https://github.com/eustasy/puff-serverless/tree/main/sql)                             | Database schema definitions (e.g., `users.sql`, `sessions.sql`).                                      | N/A (reference only)  |

### Special Files

| File                                                                                                                                   | Contents                                                           | Deployed to                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [worker.ts](https://github.com/eustasy/puff-serverless/blob/cf-pages/worker.ts)                                                        | Worker entry (`main`): compiled `fetch` + the `scheduled` handler. | Bundled into Worker                                                                                       |
| [public/\_redirects](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_redirects)                                       | Redirect Rules                                                     | [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)                 |
| [public/\_headers](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_headers)                                           | HTTP response headers                                              | [Cloudflare Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)                     |
| _build.sh_                                                                                                                             | Build Commands                                                     | [Cloudflare Pages Build](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)         |
| [functions/api/db/\_middleware.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/functions/api/db/_middleware.js)           | Database connection middleware.                                    | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |
| [functions/api/db/auth/\_middleware.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/functions/api/db/auth/_middleware.js) | Authentication middleware.                                         | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |

## Libraries

| Library | Version                          | Type           | Location                                                                                                                    | Source                                      |
| ------- | -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| HTMX    | 2.0.4                            | Client-Side JS | [public/assets/htmx_2.0.4.min.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/assets/htmx_2.0.4.min.js) | [htmx.org](https://htmx.org/)               |
| otplib  | ^12.0.1 (or as per package.json) | Server-Side JS | Node module, installed via npm                                                                                              | [npm](https://www.npmjs.com/package/otplib) |
| pg      | ^8.0.16 (or as per package.json) | Server-Side JS | Node module, installed via npm                                                                                              | [npm](https://www.npmjs.com/package/pg)     |

## APIs

External APIs used:

- https://haveibeenpwned.com/API/v2#SearchingPwnedPasswordsByRange
- Cloudflare Turnstile (implicitly via Pages dashboard configuration)

## Environment Variables

Operator-configurable runtime values, read from `context.env` (Cloudflare Pages Functions binding). Set these as plain `vars` in `wrangler.jsonc` for production, or in `.dev.vars` (or `.env`) for local development.

| Variable                  | Default                                 | Read at                                                                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_MAX_AGE_SECONDS` | `2592000`                               | `functions/api/db/2fa/login.js`                                                                           | Lifetime of the `session_token` cookie issued after a successful 2FA login, in seconds. Default is 30 days. Note: distinct from the server-side session row expiry in `src/sessions.js` (currently hardcoded to 7 days), so a cookie can outlive the DB row and the server will reject it on the next request.                                                                     |
| `SECURE_COOKIE`           | _unset_                                 | `functions/api/db/user/login.js`, `functions/api/db/2fa/login.js`, `functions/api/db/auth/user/logout.js` | When truthy, appends `Secure` to every `Set-Cookie` header issued by the login and logout flows, so cookies are only sent over HTTPS. Should be set in production.                                                                                                                                                                                                                 |
| `COOKIE_SAMESITE`         | `Lax`                                   | `functions/api/db/user/login.js`, `functions/api/db/2fa/login.js`, `functions/api/db/auth/user/logout.js` | `SameSite` policy applied to every auth cookie issued by the login and logout flows (including clear-cookie responses). Valid values: `Lax`, `Strict`, `None`. Default `Lax` lets the cookie survive top-level navigation after a redirect (e.g. clicking a verification-email link); pick `Strict` for tighter CSRF protection if you don't need that.                            |
| `APP_NAME`                | `PuffAuth`                              | `functions/api/db/auth/2fa/setup/start.js`                                                                | TOTP issuer name shown by authenticator apps (e.g. Google Authenticator, 1Password) next to each account entry, and embedded in the `otpauth://` URI written to the setup QR code.                                                                                                                                                                                                 |
| `APP_URL`                 | _unset_                                 | `src/mailer.js`                                                                                           | Absolute origin (e.g. `https://auth.example.com`, no trailing slash) used to build verification and password-reset links inside outgoing emails. Required for email delivery — when unset, `src/mailer.js` logs an error and returns a failure envelope rather than sending a broken relative link.                                                                                |
| `MAILTRAP_TOKEN`          | _unset_                                 | `src/mailer.js`                                                                                           | Mailtrap API token used as the `Bearer` credential for the send API. **Secret** — set via `wrangler secret put` in production; never commit it. Required for email delivery.                                                                                                                                                                                                       |
| `MAILTRAP_SENDER`         | _unset_                                 | `src/mailer.js`                                                                                           | Verified sender email address emails are sent `from`. Required for email delivery.                                                                                                                                                                                                                                                                                                 |
| `MAILTRAP_SENDER_NAME`    | `APP_NAME` or `PuffAuth`                | `src/mailer.js`                                                                                           | Sender display name shown alongside `MAILTRAP_SENDER`. Falls back to `APP_NAME`, then `PuffAuth`.                                                                                                                                                                                                                                                                                  |
| `MAILTRAP_API_URL`        | `https://send.api.mailtrap.io/api/send` | `src/mailer.js`                                                                                           | Mailtrap send endpoint. Override to target a Mailtrap sandbox/testing inbox (`https://sandbox.api.mailtrap.io/api/send/{inbox_id}`) for local development instead of delivering real mail.                                                                                                                                                                                         |
| `MIN_PASSWORD_LENGTH`     | `12`                                    | `src/passwords.ts` (`minPasswordLength`)                                                                  | Minimum accepted password length, enforced at register / change / reset. Can only **raise** the minimum above the built-in floor of `12` — a missing, non-numeric, or `<= 12` value falls back to `12`. When raised, a login with a now-too-short (but correct) password is paused: the user is redirected to `/password-upgrade` to set a longer one before a session is granted. |
| `REQUIRE_NUMBER`          | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one digit. Shown as a soft suggestion in the requirements UI when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                                                |
| `REQUIRE_CAPITAL`         | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one uppercase letter. Shown as a soft suggestion when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                                                            |
| `REQUIRE_SPECIAL_CHAR`    | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one character that is not a letter or digit (spaces count). Shown as a soft suggestion when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                      |
| `REQUIRE_NOT_COMPROMISED` | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to reject passwords found in HaveIBeenPwned breach data (k-anonymity prefix query — the password never leaves the server). Fail-open: a HIBP network error is treated as passing so an outage never blocks legitimate users.                                                                                                                                       |
| `SHOW_ZXCVBN`             | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to display the zxcvbn strength estimate and feedback in the requirements UI without enforcing a minimum score. Automatically enabled when `REQUIRE_ZXCVBN` is set.                                                                                                                                                                                                 |
| `REQUIRE_ZXCVBN`          | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require a zxcvbn score ≥ 3 ("safely unguessable"). When set, `REQUIRE_NUMBER` / `REQUIRE_CAPITAL` / `REQUIRE_SPECIAL_CHAR` are shown as suggestions rather than hard requirements; `MIN_PASSWORD_LENGTH` still applies.                                                                                                                                         |

## Database Schema Changes

SQL schema is stored in the `sql` folder with one file per table.

**`secrets` Table Usage:**

The `secrets` table is primarily used for storing sensitive information related to a user, with `secret_type` differentiating the kind of secret.

- **User Passwords**:
  - `secret_type`: `'puff_password_${algo}'`
  - `secret_value`: Stores the hashed user password (e.g., using Argon2id).
  - `is_enabled`: Typically `true`. Could be used to indicate an old password if a rotation policy is implemented, but generally, only the active password hash is stored.
  - `secret_created_at`, `secret_last_used`: Timestamps for creation and last usage.
- **2FA (TOTP) Secrets**:
  - `secret_type`: `'totp_secret'`
  - `secret_value`: Stores the encrypted TOTP secret key.
  - `secret_name`: Stores an identifier for the authenticator app (e.g., "PuffAuth:username").
  - `is_enabled`: Boolean (true/false) indicating if 2FA is active for the user with this specific secret.
  - `secret_created_at`, `secret_last_used`: Timestamps for creation and last usage.
- **Other potential uses** (if any, this is an example):
  - `secret_type`: `'api_key'`
  - `secret_value`: Stores an encrypted external API key.

**`tokens` Table Usage:**

The `tokens` table is used for storing various types of temporary tokens, each serving a distinct purpose, identified by `token_type`.

- **Email Verification Tokens**:
  - `token_type`: `'email_verify'`
  - `token_value`: The unique token sent to the user's email.
  - `user_uuid`: Links to the user who needs to verify their email.
  - `email_address`: The email address to be verified.
  - `expires_at`: Timestamp indicating when the token is no longer valid.
  - `is_used`: Boolean indicating if the token has already been used.
- **Password Reset Tokens**:
  - `token_type`: `'password_reset'`
  - `token_value`: The unique token sent for resetting a password.
  - `user_uuid`: Links to the user requesting the password reset.
  - `expires_at`: Expiration timestamp.
  - `is_used`: Boolean.
- **2FA Login Step-Up Token**:
  - `token_type`: `'totp_verification_token'` (or similar, as used in `db/user/login.js` and `db/2fa/login.js`)
  - `token_value`: A short-lived token generated after initial password verification, used to authorize the 2FA step.
  - `user_uuid`: The user attempting to log in.
  - `expires_at`: Typically a very short expiration time (e.g., 5-10 minutes).
  - `is_used`: Boolean.

It's crucial that `token_type` and `secret_type` are used consistently throughout the application to ensure correct retrieval and processing of these values. All sensitive values in these tables (like `secret_value`) should be appropriately protected (e.g., encrypted, hashed where applicable).

**`key_values` Table Usage:**

The `key_values` table is a per-user key/value store for arbitrary string metadata — the successor to the PHP server's `KeyValues` table.

- `user_uuid`, `kv_key`: Composite primary key — one value per key per user. The key is also the lookup index, so no secondary index is needed.
- `kv_value`: The stored value (up to `MAX_VALUE_LENGTH`).
- `created_at`, `updated_at`: Timestamps; `updated_at` is refreshed by `setKeyValue` on every upsert.
- Managed by `src/keyvalues.ts` and the `functions/api/db/auth/keyvalues/` endpoints (`list`, `set`, `remove`). Rows are removed with the user via `ON DELETE CASCADE`.

## Project Maintenance

[Dependabot](https://github.com/eustasy/puff-serverless/blob/cf-pages/.github/dependabot.yml) should update NPM and GitHub Actions with automatic pull requests.

The Cloudflare `compatibility_date` may need updating in `wrangler.jsonc`
