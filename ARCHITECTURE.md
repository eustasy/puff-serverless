# Architecture

## Deployment

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
