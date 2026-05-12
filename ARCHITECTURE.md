# Architecture

## Table of Contents

- [Deployment](#deployment)
  - [First time project setup](#first-time-project-setup)
  - [Continuous Development](#continuous-development)
  - [Directories](#directories)
  - [Special Files](#special-files)
- [Libraries](#libraries)
- [APIs](#apis)
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

TODO

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

### Directories

| Folder                                                                                      | Contents                                                                                              | Deployed to        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------ |
| [public](https://github.com/eustasy/puff-serverless/tree/main/public)                       | All static files: HTML (e.g., `index.html`, `login.html`), CSS, Client-Side JS (e.g., `htmx.min.js`). | Cloudflare Pages   |
| [functions](https://github.com/eustasy/puff-serverless/tree/main/functions)                 | Dynamic endpoints: pages that must load with pre-inserted data.                                       | Cloudflare Workers |
| [functions/api](https://github.com/eustasy/puff-serverless/tree/main/functions/api)         | API Endpoints that only require server-side JavaScript.                                               | Cloudflare Workers |
| [functions/api/db](https://github.com/eustasy/puff-serverless/tree/main/functions/api)      | API Endpoints that require database access.                                                           | Cloudflare Workers |
| [functions/api/db/auth](https://github.com/eustasy/puff-serverless/tree/main/functions/api) | API Endpoints that require authentication.                                                            | Cloudflare Workers |
| [src](https://github.com/eustasy/puff-serverless/tree/main/src)                             | Backend logic, organized by domain (e.g., `users.js`, `sessions.js`, `2fa.js`).                       | Cloudflare Workers |
| [src/utilities](https://github.com/eustasy/puff-serverless/tree/main/src/utilities)         | Utility functions (e.g., `hashing.js`, `headers.js`).                                                 | Cloudflare Workers |
| [sql](https://github.com/eustasy/puff-serverless/tree/main/sql)                             | Database schema definitions (e.g., `users.sql`, `sessions.sql`).                                      | N/A (Reference)    |

### Special Files

| File                                                                                                                                   | Contents                        | Deployed to                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [public/\_redirects](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_redirects)                                       | Redirect Rules                  | [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)                 |
| [public/\_headers](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_headers)                                           | Headers (Pages Only)            | [Cloudflare Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)                     |
| _build.sh_                                                                                                                             | Build Commands                  | [Cloudflare Pages Build](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)         |
| [functions/api/db/\_middleware.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/functions/api/db/_middleware.js)           | Database connection middleware. | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |
| [functions/api/db/auth/\_middleware.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/functions/api/db/auth/_middleware.js) | Authentication middleware.      | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |

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

## Project Maintenance

[Dependabot](https://github.com/eustasy/puff-serverless/blob/cf-pages/.github/dependabot.yml) should update NPM and GitHub Actions with automatic pull requests.

The Cloudflare `compatibility_date` may need updating in `wrangler.jsonc`
