---
applyTo: "sql/**,src/**,functions/api/db/**"
---

# Database Instructions

## Database Engine

- CockroachDB (Postgres-compatible) accessed via Cloudflare Hyperdrive.
- Client library: `pg` (node-postgres).

## Schema

Schema files live in `sql/`, one file per table. Import in foreign-key order: `users.sql` first, then `organisations.sql` → `teams.sql` → `organisation_members.sql` / `team_members.sql` / `organisation_invitations.sql`. `apps.sql` has no FK dependencies (linked apps are globally registered by the operator, not org-owned) and can be imported any time after `users.sql`. The six `*_key_values.sql` tables (`user`, `team`, `organisation`, `org_role`, `team_role`, `app`) depend on `users`, `organisations`, and `apps`; `oauth_grants.sql` and `oauth_consents.sql` depend on both `users` and `apps`. Every other table depends only on `users`.

### Tables

- **`users`**: `user_uuid` (PK), `user_name`, `user_active` (account enabled/disabled flag), `user_created_at`, `user_last_login`.
- **`sessions`**: `session_id` (PK), `user_uuid` (FK), `created_at`, `expires_at`, `is_active`, `last_accessed_at`, `last_accessed_ip`, `user_agent`, `ip_address`, `ip_country`.
- **`emails`**: `email_address` (PK), `user_uuid` (FK), `is_primary`, `is_verified`, `verified_at`.
- **`secrets`**: `secret_uuid` (PK), `user_uuid` (FK), `secret_type`, `secret_value`, `secret_name`, `is_enabled`, `secret_created_at`, `secret_last_used`. Used for both passwords (`secret_type = 'puff_password_SHA-384'`) and TOTP (`secret_type = 'totp_secret'`).
- **`tokens`**: `token_value` (PK), `user_uuid` (FK), `token_type`, `expires_at`, `created_at`, `is_used`, `email_address`. Types: `'email_verification'`, `'password_reset'`, `'totp_verification_pending'`, `'sudo_elevation'`.
- **`organisations`**: `org_uuid` (PK), `org_name`, `org_active`, `org_created_at`, `org_created_by` (FK → `users`, `ON DELETE SET NULL`).
- **`teams`**: `team_uuid` (PK), `org_uuid` (FK → `organisations`, cascade), `team_name`, `team_created_at`.
- **`organisation_members`**: composite PK `(org_uuid, user_uuid, role)`, FKs to `organisations` / `users` (cascade), `added_at`, `added_by` (FK → `users`, `SET NULL`). One row per (user, role).
- **`team_members`**: composite PK `(team_uuid, user_uuid, role)`, FKs to `teams` / `users` (cascade), `added_at`, `added_by`. Same shape as `organisation_members`.
- **`organisation_invitations`**: `invitation_token` (PK), `org_uuid` (FK → `organisations`, cascade), `email_address`, `roles` (`STRING[]`), `invited_by` (FK → `users`, `SET NULL`), `created_at`, `expires_at`, `is_used`.
- **`apps`**: `app_uuid` (PK), `app_name`, `client_id` (UNIQUE), `client_secret` (hashed), `redirect_uris` (`STRING[]`, exact-match allowlist), `app_active`, `app_created_at`. Globally registered OAuth clients — no organisation FK; operator-managed.
- **`*_key_values`** (six tables: `user`, `team`, `organisation`, `org_role`, `team_role`, `app`): subject FK(s) + `kv_key` / `kv_value` + three nullable owner FKs (`owner_user_uuid` → `users`, `owner_org_uuid` → `organisations`, `owner_app_uuid` → `apps`, all CASCADE) + computed STORED `owner_id = COALESCE(...)` + CHECK that exactly one owner is set. PK includes `owner_id` so (subject, owner, key) is unique. The `app` subject is the resolver's final fallback tier when the owner is the app itself.
- **`oauth_grants`**: `grant_value` (PK), `grant_type` (`'authorization_code'` | `'refresh_token'`), `user_uuid` (FK → `users`, cascade), `app_uuid` (FK → `apps`, cascade), `scopes` (`STRING[]`), `redirect_uri`, `code_challenge`, `code_challenge_method` (PKCE — populated on auth-code rows), `parent_grant_value` (refresh-token rotation chain; plain column), `expires_at`, `created_at`, `is_used`. Access tokens are JWTs and not stored here.
- **`oauth_consents`**: composite PK `(user_uuid, app_uuid)`, FKs to both (cascade), `scopes` (`STRING[]`), `granted_at`. Remembered per-(user, app) scope grant so the consent screen is skipped on the next OAuth round-trip.

## Query Conventions

- Always use parameterized queries with `$1`, `$2`, etc. to prevent SQL injection.
- Access the database client from `context.data.dbClient` in API handlers. The middleware handles connection and teardown.
- `src/` functions receive `dbClient` as their first parameter — they never create or close connections.
- Use `RETURNING` clause when insert/update results need confirmation.
- Use `LIMIT 1` for single-record lookups.
- Functions that check existence return `{ success: true, exists: boolean }`.
- Functions that read records return the envelope: `{ success: true, <key>: record, status: 200 }` on hit, `{ success: false, message: "...", status: 4xx }` on miss, `{ error: true, message: "...", details, status: 500 }` on DB error.

## Transactions

Wrap multi-step writes in explicit transactions when a partial failure would leave the database in an inconsistent state. Do **not** hand-roll `BEGIN`/`COMMIT`/`ROLLBACK` — use `runInTransaction` from `src/utilities/transaction.ts`:

```typescript
import { runInTransaction, Rollback } from "./utilities/transaction.js"

return await runInTransaction(dbClient, async (): Promise<Envelope> => {
  // multiple INSERT/UPDATE/DELETE statements
  return { success: true, status: 200 }
})
```

`runInTransaction` owns the transaction boundary: it issues the `BEGIN`/`COMMIT`, rolls back on any throw, and resolves with whatever the callback returns. The callback **must not** issue its own `BEGIN`/`COMMIT`/`ROLLBACK`.

### Why this is required (CockroachDB SERIALIZABLE)

CockroachDB runs every transaction at SERIALIZABLE isolation. When it cannot order a transaction against a concurrent one, it aborts the loser with a _retryable_ serialization failure (SQLSTATE `40001` / `RETRY_SERIALIZABLE`) and expects the client to **rerun the whole transaction**. A multi-statement transaction issued over separate round-trips cannot be retried server-side, so `runInTransaction` does it — up to 5 attempts with exponential backoff + jitter. Hand-rolled `BEGIN`/`COMMIT` blocks turn a retryable `40001` into a spurious 500.

Single auto-committed statements outside an explicit transaction are auto-retried by the server and need no wrapping.

### Aborting with a non-error result

To abort the transaction (ROLLBACK) but resolve with a value instead of throwing — e.g. a not-found row or a limit hit _after_ a write has already been issued — `throw new Rollback(value)`. `runInTransaction` rolls back and resolves with `value`; it is never treated as retryable. Use this for business-rule aborts so a partial transaction is never committed:

```typescript
return await runInTransaction(dbClient, async (): Promise<Envelope> => {
  const result = await dbClient.query("UPDATE ... RETURNING ...", [id])
  if ((result.rowCount ?? 0) === 0) {
    throw new Rollback<Envelope>({
      success: false,
      message: "Not found.",
      status: 404,
    })
  }
  // ... further writes ...
  return { success: true, status: 200 }
})
```

The callback may run more than once, so it must be safe to replay — no external side effects that cannot be repeated.

Examples in the codebase:

- `setPrimaryEmail` (`src/emails.ts`) wraps demote-old-primary + promote-new-primary.
- `updatePassword` (`src/passwords.ts`) wraps disable-old + create-new.
- `upsertKeyValue` (`src/utilities/keyvalues-shared.ts`) wraps the per-owner key-count check + insert — shared by all five KV subject modules.
- `disableUser` (`src/users.ts`) wraps the inactive-flag flip + session purge.

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
