# Architecture

## Table of Contents

- [Deployment](#deployment)
  - [First time project setup](#first-time-project-setup)
  - [Continuous Development](#continuous-development)
  - [Deploying to Production](#deploying-to-production)
  - [Scheduled cleanup](#scheduled-cleanup)
  - [OAuth signing-key rotation](#oauth-signing-key-rotation)
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

_Note: SQL Schema can be found in the SQL folder, one file per table. Import in foreign-key order: `users.sql` first (it provides the foreign key for many other tables), then `organisations.sql` → `teams.sql` → `organisation_members.sql` / `team_members.sql` / `organisation_invitations.sql`. `apps.sql` has no FK dependencies (linked apps are globally registered by the operator, not org-owned) and can be imported any time after `users.sql`; the six `*_key_values.sql` tables (including `app_key_values.sql`) depend on `users`, `organisations`, and `apps`; `oauth_grants.sql` and `oauth_consents.sql` depend on both `users` and `apps`. Every other table depends only on `users`._

##### for Local Development

You can override the Hyperdrive connection strings by setting the following in `.env`:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/databasename"
```

##### for Production Deployment

Production uses [CockroachDB Cloud](https://www.cockroachlabs.com/) (or any Postgres-compatible database) reached through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), which pools connections at the edge.

1. Provision the database and import the schema from `sql/` — **`users.sql` first** (it provides the foreign key the other tables depend on), then `organisations.sql` → `teams.sql` → `organisation_members.sql` / `team_members.sql` / `organisation_invitations.sql`. `apps.sql` has no FK dependencies and can be imported any time after `users.sql`; the six `*_key_values.sql` tables depend on `users`, `organisations`, and `apps`; `oauth_grants.sql` and `oauth_consents.sql` depend on both `users` and `apps`. Every other table depends only on `users`.
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

### OAuth signing-key rotation

The OAuth/OIDC provider signs ID tokens and access tokens with an ES256 (ECDSA P-256) keypair. The private key lives in the `OAUTH_SIGNING_KEY_PRIVATE` secret; the matching public key is derived at runtime, exposed via `/.well-known/jwks.json`, and identified by an RFC 7638 thumbprint `kid` (so the kid is deterministic from the key — no separate binding).

Rotation is **a manual operator action** — there is no cron job that rotates keys on its own. The overlap window during rotation is what keeps already-issued JWTs valid until they expire.

**First-time setup** (or rotation):

1. Generate a fresh keypair: `node scripts/generate-oauth-key.mjs`. The script prints the private JWK (a single-line JSON string), the public JWK with its `kid`, and the exact `wrangler secret put` command to run.
2. _(Rotation only — skip on first setup.)_ Copy the previous **public** JWK (the `kty` / `crv` / `x` / `y` fields, without `kid` / `use` / `alg` / `d`) into the `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` binding via the dashboard or `wrangler secret put`. This keeps JWTs signed by the retired key validating in JWKS during the overlap window.
3. Push the new private JWK: `echo '…' | npx wrangler secret put OAUTH_SIGNING_KEY_PRIVATE`.
4. For local development, set the same JWK in `.env` as `OAUTH_SIGNING_KEY_PRIVATE`.
5. After the longest-lived JWT has expired (the access-token / ID-token lifetime — order of an hour), clear `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC`.

`/.well-known/jwks.json` exposes the active public JWK and, if the previous-public binding is set, the retired one alongside it.

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

### OAuth 2.1 / OIDC endpoints

Puff is itself an OAuth 2.1 / OpenID Connect provider. Registered apps log their users in with Puff via the Authorization Code flow with PKCE. **Confidential clients only** — every app has a `client_secret` and authenticates on `/oauth/token` via HTTP Basic (`client_secret_basic`) or body params (`client_secret_post`). PKCE is required on every code exchange regardless (OAuth 2.1, `S256` only).

| Endpoint                            | Method   | Purpose                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/oauth/authorize`                  | GET/POST | The user-facing entry point. Validates `client_id`/`redirect_uri`/`response_type`/`code_challenge`, redirects to `/login` when no session, server-renders a consent screen when `oauth_consents` does not already cover the requested scopes, then redirects back with `?code=`. |
| `/oauth/token`                      | POST     | Exchanges `grant_type=authorization_code` (consumed atomically, PKCE verified) for `access_token` + `id_token` (when `openid` scope was granted) + `refresh_token` (when `offline_access` was granted). Also rotates `grant_type=refresh_token`.                                 |
| `/oauth/userinfo`                   | GET      | Bearer-authenticated OIDC claim response: `{ sub, name?, email?, email_verified? }` depending on the scope claim baked into the access-token JWT.                                                                                                                                |
| `/.well-known/openid-configuration` | GET      | OIDC Discovery document — issuer, all endpoint URLs, supported response/grant types, scopes, claims, and signing algorithm.                                                                                                                                                      |
| `/.well-known/jwks.json`            | GET      | JWKS — the active public signing key plus, during a rotation overlap window, the retired one (see [OAuth signing-key rotation](#oauth-signing-key-rotation)).                                                                                                                    |

Lifetimes: authorization code 5 min, access token + ID token 1 hour, refresh token 30 days. Access tokens are stateless JWTs (`ES256`); only authorization codes and refresh tokens persist in `oauth_grants`. Remembered consent is per-(user, app) in `oauth_consents`. Domain modules: `src/apps.ts`, `src/oauth-grants.ts`, `src/oauth-consents.ts`, `src/oauth.ts` (shared helpers), `src/oauth-jwt.ts` + `src/oauth-keys.ts` (signing).

## Environment Variables

Operator-configurable runtime values, read from `context.env` (Cloudflare Pages Functions binding). Set these as plain `vars` in `wrangler.jsonc` for production, or in `.dev.vars` (or `.env`) for local development.

| Variable                            | Default                                 | Read at                                                                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_MAX_AGE_SECONDS`           | `2592000`                               | `functions/api/db/2fa/login.js`                                                                           | Lifetime of the `session_token` cookie issued after a successful 2FA login, in seconds. Default is 30 days. Note: distinct from the server-side session row expiry in `src/sessions.js` (currently hardcoded to 7 days), so a cookie can outlive the DB row and the server will reject it on the next request.                                                                     |
| `SECURE_COOKIE`                     | _unset_                                 | `functions/api/db/user/login.js`, `functions/api/db/2fa/login.js`, `functions/api/db/auth/user/logout.js` | When truthy, appends `Secure` to every `Set-Cookie` header issued by the login and logout flows, so cookies are only sent over HTTPS. Should be set in production.                                                                                                                                                                                                                 |
| `COOKIE_SAMESITE`                   | `Lax`                                   | `functions/api/db/user/login.js`, `functions/api/db/2fa/login.js`, `functions/api/db/auth/user/logout.js` | `SameSite` policy applied to every auth cookie issued by the login and logout flows (including clear-cookie responses). Valid values: `Lax`, `Strict`, `None`. Default `Lax` lets the cookie survive top-level navigation after a redirect (e.g. clicking a verification-email link); pick `Strict` for tighter CSRF protection if you don't need that.                            |
| `APP_NAME`                          | `PuffAuth`                              | `functions/api/db/auth/2fa/setup/start.js`                                                                | TOTP issuer name shown by authenticator apps (e.g. Google Authenticator, 1Password) next to each account entry, and embedded in the `otpauth://` URI written to the setup QR code.                                                                                                                                                                                                 |
| `APP_URL`                           | _unset_                                 | `src/mailer.js`                                                                                           | Absolute origin (e.g. `https://auth.example.com`, no trailing slash) used to build verification and password-reset links inside outgoing emails. Required for email delivery — when unset, `src/mailer.js` logs an error and returns a failure envelope rather than sending a broken relative link.                                                                                |
| `MAILTRAP_TOKEN`                    | _unset_                                 | `src/mailer.js`                                                                                           | Mailtrap API token used as the `Bearer` credential for the send API. **Secret** — set via `wrangler secret put` in production; never commit it. Required for email delivery.                                                                                                                                                                                                       |
| `MAILTRAP_SENDER`                   | _unset_                                 | `src/mailer.js`                                                                                           | Verified sender email address emails are sent `from`. Required for email delivery.                                                                                                                                                                                                                                                                                                 |
| `MAILTRAP_SENDER_NAME`              | `APP_NAME` or `PuffAuth`                | `src/mailer.js`                                                                                           | Sender display name shown alongside `MAILTRAP_SENDER`. Falls back to `APP_NAME`, then `PuffAuth`.                                                                                                                                                                                                                                                                                  |
| `MAILTRAP_API_URL`                  | `https://send.api.mailtrap.io/api/send` | `src/mailer.js`                                                                                           | Mailtrap send endpoint. Override to target a Mailtrap sandbox/testing inbox (`https://sandbox.api.mailtrap.io/api/send/{inbox_id}`) for local development instead of delivering real mail.                                                                                                                                                                                         |
| `MIN_PASSWORD_LENGTH`               | `12`                                    | `src/passwords.ts` (`minPasswordLength`)                                                                  | Minimum accepted password length, enforced at register / change / reset. Can only **raise** the minimum above the built-in floor of `12` — a missing, non-numeric, or `<= 12` value falls back to `12`. When raised, a login with a now-too-short (but correct) password is paused: the user is redirected to `/password-upgrade` to set a longer one before a session is granted. |
| `REQUIRE_NUMBER`                    | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one digit. Shown as a soft suggestion in the requirements UI when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                                                |
| `REQUIRE_CAPITAL`                   | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one uppercase letter. Shown as a soft suggestion when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                                                            |
| `REQUIRE_SPECIAL_CHAR`              | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require at least one character that is not a letter or digit (spaces count). Shown as a soft suggestion when `REQUIRE_ZXCVBN` is also set.                                                                                                                                                                                                                      |
| `REQUIRE_NOT_COMPROMISED`           | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to reject passwords found in HaveIBeenPwned breach data (k-anonymity prefix query — the password never leaves the server). Fail-open: a HIBP network error is treated as passing so an outage never blocks legitimate users.                                                                                                                                       |
| `SHOW_ZXCVBN`                       | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to display the zxcvbn strength estimate and feedback in the requirements UI without enforcing a minimum score. Automatically enabled when `REQUIRE_ZXCVBN` is set.                                                                                                                                                                                                 |
| `REQUIRE_ZXCVBN`                    | off                                     | `src/passwords.ts` (`passwordConfig`)                                                                     | Set to `"true"` to require a zxcvbn score ≥ 3 ("safely unguessable"). When set, `REQUIRE_NUMBER` / `REQUIRE_CAPITAL` / `REQUIRE_SPECIAL_CHAR` are shown as suggestions rather than hard requirements; `MIN_PASSWORD_LENGTH` still applies.                                                                                                                                         |
| `OAUTH_SIGNING_KEY_PRIVATE`         | _unset_                                 | `src/oauth-keys.ts` (`loadSigningKey`, `currentPublicJwk`)                                                | Active ES256 (ECDSA P-256) private key as a JWK JSON string. **Secret** — set via `wrangler secret put OAUTH_SIGNING_KEY_PRIVATE`. The matching public key is derived from this binding at runtime and exposed via `/.well-known/jwks.json`; no separate public binding is needed. Generate a fresh keypair with `node scripts/generate-oauth-key.mjs`.                            |
| `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` | _unset_                                 | `src/oauth-keys.ts` (`previousPublicJwk`), `functions/.well-known/jwks.json.ts`                           | Optional retired public JWK held during a key-rotation overlap window so JWTs signed by the old key continue to verify. JSON string of the public JWK (`kty`, `crv`, `x`, `y` — no `kid`/`use`/`alg`/`d`). Set when rotating; clear once the longest-lived JWT has expired.                                                                                                        |

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

**Key/Value Store Table Usage:**

The KV store is the unified mechanism for both descriptive per-entity metadata and the data-driven permission/entitlement system (see Phase 7 in `TODO.md`). One table per **subject** type, each row carrying a first-class **owner** dimension — so app A's row about user U and org O's row about user U coexist as different rows.

- **`user_key_values`** — subject `user_uuid → users`. Successor to the PHP `KeyValues` table; also stores app-owned and org-owned data attached to a user.
- **`team_key_values`** — subject `team_uuid → teams`. Team-level defaults.
- **`organisation_key_values`** — subject `org_uuid → organisations`. Org-level data (e.g. licensing).
- **`org_role_key_values`** — subject `(org_uuid, role)`. Data scoped to a specific org role; perms applied to every user holding that role.
- **`team_role_key_values`** — subject `(team_uuid, role)`. Same idea, scoped to a team role.
- **`app_key_values`** — subject `app_uuid → apps`. The app's globally-applied defaults — the final fallback in the resolution chain when the owner is the app itself.

Every table has the same shape: subject FK(s) (NOT NULL, CASCADE) + `kv_key`/`kv_value` + three nullable owner FKs (`owner_user_uuid` / `owner_org_uuid` / `owner_app_uuid`, all CASCADE) + computed STORED `owner_id = COALESCE(owner_user_uuid, owner_org_uuid, owner_app_uuid)` + a CHECK that exactly one owner column is set. The primary key includes `owner_id`, so the unique tuple is (subject, owner, key). `created_at` / `updated_at` are managed in `src/utilities/keyvalues-shared.ts`'s shared upsert.

Managed by `src/{user,team,organisation,org-role,team-role,app}-keyvalues.ts` (each exports `readKeyValue` / `readKeyValues` / `searchKeyValues` / `setKeyValue` / `deleteKeyValue`), the shared `src/utilities/keyvalues-shared.ts`, the inheritance-resolver in `src/keyvalues-resolver.ts`, and endpoints under `functions/api/db/auth/keyvalues/` (self-owned user data) and `functions/api/db/auth/organisations/[org_uuid]/...keyvalues/...` (org-owned data against org / users / teams / roles).

The resolver walks **user → team-role → org-role → team → org → app** (most-specific first), filtered by the `owner` namespace, returning `{ values: string[], source }`. The role tier merges + de-duplicates when a user holds multiple roles with values for the same key — by design, roles do not override each other within a tier. The `app` tier only fires when `owner.type === "app"` — it represents the app's own default for any user that touches it, the final fallback when every more-specific tier missed.

**Organisations, Teams & Memberships Table Usage:**

Phase 6 multi-tenancy. A user account is global; their relationship to an organisation is the set of role grants they hold (see `src/permissions.ts` for the role and capability model).

- **`organisations`** — top-level tenant. `org_uuid` (PK), `org_name`, `org_active` (reversible-disable flag, mirroring `user_active`), `org_created_at`, `org_created_by` (FK → `users`, `ON DELETE SET NULL`). Identified by UUID — there is no slug, and names need not be unique. Managed by `src/organisations.ts`.
- **`teams`** — a subdivision of one organisation. `team_uuid` (PK), `org_uuid` (FK → `organisations`, `ON DELETE CASCADE`), `team_name`, `team_created_at`. Managed by `src/teams.ts`.
- **`organisation_members`** — organisation-scoped role grants. Composite PK `(org_uuid, user_uuid, role)`, so each (user, role) is one row and a user may hold several roles. FKs to `organisations` and `users` (`ON DELETE CASCADE`); `added_by` (FK → `users`, `ON DELETE SET NULL`).
- **`team_members`** — team-scoped role grants, the same shape keyed on `team_uuid`. Team membership does not _require_ organisation membership at the schema level, but in practice guests are surfaced via the explicit `guest` org role (see below) so the relationship is always represented in `organisation_members`. The `guest` row grants `org:view` only; the user's effective team access still flows from `team_members`.
- **`organisation_invitations`** — pending invitations. `invitation_token` (PK), `org_uuid` (FK → `organisations`, `ON DELETE CASCADE`), `email_address`, `roles` (the role set granted on acceptance), `invited_by` (FK → `users`, `ON DELETE SET NULL`), `expires_at`, `is_used`. Consumed atomically by `acceptInvitation` in `src/invitations.ts`.

Membership and invitation management lives in `src/memberships.ts` / `src/invitations.ts` and the `functions/api/db/auth/organisations/` endpoints. `role` is plain text validated against `src/permissions.ts`; Phase 7 will move it to a `roles` table.

**Linked Apps Table Usage:**

Phase 7 OAuth provider work. Apps are **globally registered by the operator**, not owned by any organisation — any org can grant its users/teams entitlements for any registered app.

- **`apps`** — registered OAuth clients. `app_uuid` (PK), `app_name`, `client_id` (UNIQUE — the public OAuth identifier), `client_secret` (hashed via `src/utilities/hashing.ts`), `redirect_uris STRING[]` (exact-match allowlist for the OAuth `redirect_uri` parameter), `app_active` (reversible disable), `app_created_at`. No FK to `organisations` and no `created_by` — registration is an operator action performed via direct DB access until the operator UI lands.
- **`oauth_grants`** — DB-backed OAuth state: authorization codes and refresh tokens. PK `grant_value`, FKs to `users` + `apps` (both `ON DELETE CASCADE`), `grant_type` discriminator (`'authorization_code'` | `'refresh_token'`), `scopes STRING[]`, PKCE fields (`redirect_uri`, `code_challenge`, `code_challenge_method`) populated on auth-code rows, `parent_grant_value` linking each rotated refresh token back to its predecessor (plain column, not a self-FK — cleanup must not cascade through the chain), `expires_at`, `is_used`, `created_at`. Access tokens are JWTs and never appear here.
- **`oauth_consents`** — remembered consent: skip the consent screen on the next round-trip if the user has already granted these scopes. Composite PK `(user_uuid, app_uuid)`, FKs to both (`ON DELETE CASCADE`), `scopes STRING[]`, `granted_at`. UPSERT on re-consent; revoke by DELETE.

## Project Maintenance

[Dependabot](https://github.com/eustasy/puff-serverless/blob/cf-pages/.github/dependabot.yml) should update NPM and GitHub Actions with automatic pull requests.

The Cloudflare `compatibility_date` may need updating in `wrangler.jsonc`
