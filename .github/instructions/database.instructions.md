---
applyTo: "sql/**,src/**,functions/api/db/**"
---

# Database Instructions

## Database Engine

- CockroachDB (Postgres-compatible) accessed via Cloudflare Hyperdrive.
- Client library: `pg` (node-postgres).

## Schema

Schema files live in `sql/`, one file per table. `users.sql` must be imported first (foreign key dependency).

### Tables

- **`users`**: `user_uuid` (PK), `user_name`, `user_active` (account enabled/disabled flag), `user_created_at`, `user_last_login`.
- **`sessions`**: `session_id` (PK), `user_uuid` (FK), `created_at`, `expires_at`, `is_active`, `last_accessed_at`, `last_accessed_ip`, `user_agent`, `ip_address`, `ip_country`.
- **`emails`**: `email_address` (PK), `user_uuid` (FK), `is_primary`, `is_verified`, `verified_at`.
- **`secrets`**: `secret_uuid` (PK), `user_uuid` (FK), `secret_type`, `secret_value`, `secret_name`, `is_enabled`, `secret_created_at`, `secret_last_used`. Used for both passwords (`secret_type = 'puff_password_SHA-384'`) and TOTP (`secret_type = 'totp_secret'`).
- **`tokens`**: `token_value` (PK), `user_uuid` (FK), `token_type`, `expires_at`, `created_at`, `is_used`, `email_address`. Types: `'email_verification'`, `'password_reset'`, `'totp_verification_pending'`, `'sudo_elevation'`.

## Query Conventions

- Always use parameterized queries with `$1`, `$2`, etc. to prevent SQL injection.
- Access the database client from `context.data.dbClient` in API handlers. The middleware handles connection and teardown.
- `src/` functions receive `dbClient` as their first parameter — they never create or close connections.
- Use `RETURNING` clause when insert/update results need confirmation.
- Use `LIMIT 1` for single-record lookups.
- Functions that check existence return `{ success: true, exists: boolean }`.
- Functions that read records return the envelope: `{ success: true, <key>: record, status: 200 }` on hit, `{ success: false, message: "...", status: 4xx }` on miss, `{ error: true, message: "...", details, status: 500 }` on DB error.

## Transactions

Wrap multi-step writes in explicit transactions when a partial failure would leave the database in an inconsistent state:

```javascript
await dbClient.query("BEGIN")
try {
  // multiple INSERT/UPDATE/DELETE statements
  await dbClient.query("COMMIT")
} catch (txError) {
  await dbClient.query("ROLLBACK").catch(() => {})
  throw txError
}
```

Examples in the codebase:

- `setPrimaryEmail` (`src/emails.js`) wraps demote-old-primary + promote-new-primary.
- `updatePassword` (`src/passwords.js`) wraps disable-old + create-new.

The `.catch(() => {})` on `ROLLBACK` ensures a rollback-failure (e.g. already-aborted transaction) does not shadow the original thrown error.

## Conflict Handling

For inserts on tables with unique constraints, prefer `ON CONFLICT ... DO NOTHING RETURNING ...` over try/catch around the unique-violation error code:

```javascript
const result = await dbClient.query({
  text: "INSERT INTO emails (...) VALUES (...) ON CONFLICT (email_address) DO NOTHING RETURNING email_address",
  values: [...],
})
if (result.rowCount === 0) {
  // conflict — handle as appropriate for the caller (e.g. enumeration prevention)
}
```

This is cleaner than matching on `error.constraint` in a catch block (constraint names drift when the schema changes) and atomically handles concurrent-insert races. Example: `createEmail` (`src/emails.js`) uses this for the cross-user-collision case.

## Soft Deletion

- Users can be reversibly **disabled** (`disableUser`, `src/users.js`): `user_active = FALSE` plus termination of every session, in one transaction. Re-enable with `enableUser`. Queries for active users filter on `user_active = TRUE`.
- `deleteUser` (`src/users.js`) is a **permanent hard delete** — a single `DELETE FROM users`; every child row (sessions, secrets, emails, tokens, TOTP replay-guard rows) is removed by the `ON DELETE CASCADE` on each child table's `user_uuid` foreign key. Use `disableUser` for anything reversible.
- Sessions are soft-terminated by setting `is_active = FALSE`. They are never hard-deleted (except as a child row of `deleteUser`).
- Tokens are marked as used via `is_used = TRUE`. They may also be hard-deleted in some flows.

## Secrets Table Usage

The `secrets` table stores both passwords and TOTP secrets, differentiated by `secret_type`:

- **Passwords**: `secret_type = 'puff_password_{algo}'` (e.g., `puff_password_SHA-384`). `secret_value` stores `hash:salt`. Old passwords are disabled (`is_enabled = FALSE`) rather than deleted when a password changes.
- **TOTP**: `secret_type = 'totp_secret'`. `is_enabled` tracks whether 2FA is active. Created with `is_enabled = FALSE`, then enabled after verification.
