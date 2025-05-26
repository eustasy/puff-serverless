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

| File                                                                                             | Contents                           | Deployed to                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [public/\_redirects](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_redirects) | Redirect Rules                     | [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)                 |
| [public/\_headers](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_headers)     | Headers (Pages Only)               | [Cloudflare Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)                     |
| _build.sh_                                                                                       | Build Commands                     | [Cloudflare Pages Build](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)         |
| _functions/api/\_middleware.js_                                                                  | Headers and Authentication for API | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |

## Libraries

| Library | Version | Type           | Location                                                                                                      | Source                        |
| ------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| HTMX    | 2.0.4   | Client-Side JS | [public/assets/htmx_2.0.4.min.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/assets/htmx_2.0.4.min.js) | [htmx.org](https://htmx.org/) |
| otplib  | ^12.0.1 (or as per package.json) | Server-Side JS | Node module, installed via npm | [npm](https://www.npmjs.com/package/otplib) |


## APIs

External APIs used:
- https://haveibeenpwned.com/API/v2#SearchingPwnedPasswordsByRange

## Actions

High-level user actions supported:
- Register
  - Verify Email (Primary)
- Log in
  - Verify password
  - Verify 2nd factor (TOTP)
  - Create a session
- Log out
  - Terminate a session
- Reset password
- Account Mangement
  - Verify a session (middleware)
  - Add backup email
    - Verify Backup Email
  - Change primary email
  - Change password
  - Add 2nd factor (TOTP Setup & Verify)
  - Remove 2nd factor (TOTP)
  - List sessions
  - Terminate specific session
  - Terminate all other sessions

## API Endpoint Details

This section details the serverless functions acting as API endpoints.

| Path                                       | Method(s) | Description                                                                      |
| ------------------------------------------ | --------- | -------------------------------------------------------------------------------- |
| `functions/api/verify_email.js`            | GET       | Verifies a user's primary email address using a token from a link.               |
| `functions/api/user_logout.js`             | POST      | Terminates the current user's session (requires session token).                  |
| `functions/api/setup_2fa_start.js`         | POST      | Initiates 2FA setup for a logged-in user, returns QR code URI and manual code.   |
| `functions/api/setup_2fa_verify.js`        | POST      | Verifies the TOTP code provided by the user during 2FA setup, enables 2FA.     |
| `functions/api/verify_2fa_login.js`        | POST      | Verifies a TOTP code during login for users with 2FA enabled, creates session.   |
| `functions/api/request_password_reset.js`  | POST      | Initiates password reset for a user by email, sends (simulated) reset link.      |
| `functions/api/reset_password.js`          | POST      | Resets a user's password using a token and new password.                         |
| `functions/api/change_password.js`         | POST      | Allows a logged-in user to change their password (requires current password).    |
| `functions/api/add_backup_email.js`        | POST      | Allows a logged-in user to add a backup email address (sends verification).    |
| `functions/api/verify_backup_email.js`     | GET       | Verifies a user's backup email address using a token from a link.                |
| `functions/api/change_primary_email.js`    | POST      | Allows a logged-in user to change their primary email to a verified backup email.|
| `functions/api/remove_2fa.js`              | POST      | Allows a logged-in user to remove 2FA after verifying a TOTP code.             |
| `functions/api/list_sessions.js`           | GET       | Lists all active sessions for the logged-in user.                                |
| `functions/api/terminate_session.js`       | POST      | Terminates a specific session for the logged-in user.                            |
| `functions/api/terminate_all_sessions.js`  | POST      | Terminates all sessions for the logged-in user except the current one.           |

*Note: User registration and initial login (password-only part) are handled by `src/users.js` which is not a direct API endpoint but called by other functions (e.g., a hypothetical `functions/api/register.js` or `functions/api/login.js` which would then call these library functions).*

## Database Schema Changes

SQL DDL statements for schema modifications are stored in `.sql` files:
- `schema_changes.sql`: Initial `email_verifications` table, `emails.is_verified`, `emails.verified_at`. (Also contains the main `users`, `emails`, and `secrets` table definitions).
- `schema_changes_sessions.sql`: `sessions` table.
- `schema_changes_password_reset.sql`: `password_reset_tokens` table.
- `schema_changes_backup_email.sql`: `emails.is_primary` column.

Refer to these files for specific table structures and column definitions.

**Note on `secrets` table usage for 2FA:**
The `secrets` table is also used for storing Time-based One-Time Password (TOTP) configurations for 2nd Factor Authentication. This consolidation means the previously separate `two_factor_secrets` table (and its corresponding `schema_changes_2fa.sql` file) is now obsolete.
When used for TOTP:
- `secret_type` is set to `'totp_secret'`.
- `secret_value` stores the (simulated encrypted) TOTP secret key.
- `secret_name` stores the authenticator app label (e.g., "YourApp:user@example.com").
- `secret_enabled` indicates if 2FA is active for the user (1 for true, 0 for false).
- `secret_created_at` and `secret_last_used` track the creation and usage of the TOTP configuration.Okay, I have updated `ARCHITECTURE.md`. Now I will create `test_strategies.txt` with the outlined test strategies.
