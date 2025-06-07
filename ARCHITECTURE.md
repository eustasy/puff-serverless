# Architecture

## Table of Contents



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

| Folder                                                                              | Contents                                                        | Deployed to        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| [public](https://github.com/eustasy/puff-serverless/tree/main/public)               | All static files: HTML, CSS, Client-Side JS.                    | Cloduflare Pages   |
| [functions](https://github.com/eustasy/puff-serverless/tree/main/functions)         | Dynamic endpoints: pages that must load with pre-inserted data. | Cloudflare Workers |
| [functions/api](https://github.com/eustasy/puff-serverless/tree/main/functions/api) | API Endpoints                                                   | Cloudflare Workers |
| [src](https://github.com/eustasy/puff-serverless/tree/main/src)                     | Backend Code                                                    | Cloudflare Workers |

### Special Files

| File                                                                                                                   | Contents                           | Deployed to                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [public/\_redirects](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_redirects)                       | Redirect Rules                     | [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)                 |
| [public/\_headers](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_headers)                           | Headers (Pages Only)               | [Cloudflare Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)                     |
| _build.sh_                                                                                                             | Build Commands                     | [Cloudflare Pages Build](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)         |
| [functions/api/\_middleware.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/functions/api/_middleware.js) | Headers and Authentication for API | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |

## Libraries

| Library | Version                          | Type           | Location                                                                                                                    | Source                                      |
| ------- | -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| HTMX    | 2.0.4                            | Client-Side JS | [public/assets/htmx_2.0.4.min.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/assets/htmx_2.0.4.min.js) | [htmx.org](https://htmx.org/)               |
| otplib  | ^12.0.1 (or as per package.json) | Server-Side JS | Node module, installed via npm                                                                                              | [npm](https://www.npmjs.com/package/otplib) |
| pg      | ^8.0.16 (or as per package.json) | Server-Side JS | Node module, installed via npm                                                                                              | [npm](https://www.npmjs.com/package/pg)     |

## APIs

External APIs used:

- https://haveibeenpwned.com/API/v2#SearchingPwnedPasswordsByRange

## Database Schema Changes

SQL schema is stored in the sql folder with one file per table.

**Note on `secrets` table usage for 2FA:**
The `secrets` table is also used for storing Time-based One-Time Password (TOTP) configurations for 2nd Factor Authentication.
When used for TOTP:

- `secret_type` is set to `'totp_secret'`.
- `secret_value` stores the TOTP secret key.
- `secret_name` stores the authenticator app label (e.g., "YourApp:user@example.com").
- `secret_enabled` indicates if 2FA is active for the user (1 for true, 0 for false).
- `secret_created_at` and `secret_last_used` track the creation and usage of the TOTP configuration.

## Project Maintenance

[Dependabot](https://github.com/eustasy/puff-serverless/blob/cf-pages/.github/dependabot.yml) should update NPM and GitHub Actions with automatic pull requests.

The Cloudflare `compatibility_date` may need updating in `wrangler.toml`