# Hierarchy

How the data concepts fit together. Puff is multi-tenant — many organisations, each subdividable into teams, each with members and role-scoped permissions. Apps sit alongside as global resources any org can license. This file explains the relationships; the column-level table reference lives in `.github/instructions/database.instructions.md`.

For the codebase shape see [Architecture.md](Architecture.md); for operator tasks against these entities see [Operations.md](Operations.md).

## Table of Contents

- [The conceptual shape](#the-conceptual-shape)
- [Users](#users)
- [Organisations](#organisations)
- [Teams](#teams)
- [Roles and permissions](#roles-and-permissions)
- [Apps & licensing](#apps--licensing)
- [The key-value store and the resolver chain](#the-key-value-store-and-the-resolver-chain)
- [Entitlements](#entitlements)
- [How it all composes](#how-it-all-composes)

## The conceptual shape

```text
Puff                  (the deployment — one Worker, one database)
 ├─ Apps              (globally registered OAuth clients, operator-managed)
 ├─ Users             (global accounts — one user, many memberships)
 └─ Organisations     (tenants — group users, license apps)
     ├─ Teams         (subdivisions of one org)
     │   └─ Roles     (team-scoped, code-defined; map to team:* capabilities)
     └─ Roles         (org-scoped, code-defined; map to org:* capabilities)
```

Two things to internalise up front:

- **Users are global**, not per-tenant. One account, many memberships. The same user can belong to several organisations, each with a different role set.
- **Apps are also global** — registered once by the operator. There is no "org owns an app" relationship. Any organisation can grant its users entitlements for any registered app, but the app itself is shared infrastructure.

The hierarchy is mostly enforced by foreign keys with `ON DELETE CASCADE` — deleting a team removes its memberships; deleting an organisation removes its teams; deleting a user removes their session/email/password/2FA rows. The `audit_events` table is deliberately FK-less so its rows outlive their referents — see [Operations.md → Audit events & hooks](Operations.md#audit-events--hooks).

## Users

The root entity. `users` carries `user_uuid` (PK), `user_name` (display only — not a unique handle), `user_active` (reversible-disable flag), and timestamps. Everything personal to a user — their emails, password and TOTP secrets, sessions, OAuth tokens, passkeys, linked external identities — hangs off `user_uuid` with `ON DELETE CASCADE`.

A user can hold any combination of authentication factors:

- **Password** in `secrets` (`secret_type = 'puff_password_<algo>'`, hashed).
- **TOTP secret** in `secrets` (`secret_type = 'totp_secret'`). Replay-guarded by `totp_used_codes`.
- **Passkeys** in `passkeys` (WebAuthn credentials).
- **Linked external identities** in `external_identities` (GitHub/Google/Microsoft).

Login can be by password (+ optional 2FA gate), by passkey (single-step — the passkey is both factors), or by external provider (single-step — the provider is the second factor). `unlinkExternalIdentity` and `deletePasskey` refuse to remove the last usable credential, so a user can't lock themselves out.

`disableUser` flips `user_active = FALSE` and terminates every session in one transaction; `enableUser` is its reverse. `deleteUser` is a hard delete — `DELETE FROM users` cascades through all child tables — but is refused (409) if the user is the sole `owner` of any organisation.

## Organisations

`organisations` is the tenant. `org_uuid` PK, `org_name` (free-form, doesn't need to be unique — orgs are identified by UUID, not slug), `org_active` (mirrors `user_active` semantics), `org_created_by` (FK → `users`, `ON DELETE SET NULL`).

Any authenticated user can create an organisation; the creator becomes its first `owner` (atomic: `createOrganisation` inserts the row and the `organisation_members` owner row in one transaction). Org admins (the `owner` and `admin` roles) can invite or add members, manage teams, and grant entitlements.

Organisation membership is **derived from role grants**, not stored separately. A user is a "full member" of an org iff they hold at least one row in `organisation_members` for it. The roles they hold are exactly the rows present. There is no "is_member" column.

`disableOrganisation` is reversible; `enableOrganisation` flips it back. `deleteOrganisation` is a hard delete that cascades through teams, members, invitations, and all KV rows owned by or scoped to the org. The `audit_events` row for `org.deleted` survives the cascade because it has no FK back to `organisations`.

**Last-owner guard.** Both `removeOrgMember` and `setOrgMemberRoles` reject any change that would leave an organisation with zero `owner` rows. This is a transactional check inside the same `UPDATE`/`DELETE`, not an after-the-fact validation.

## Teams

`teams` are subdivisions of one organisation. `team_uuid` PK, `org_uuid` FK to `organisations` with `ON DELETE CASCADE` (drop an org, its teams go too), `team_name`, `team_created_at`.

Team membership is `team_members` (composite PK `(team_uuid, user_uuid, role)`). Schema-wise it does **not** require organisation membership — you can give a user a team role without making them a full org member, and that case is called a **guest**.

In practice, guests are surfaced explicitly. The `guest` role exists in the org-role set and grants exactly `org:view` (enough to render the org page and see the team they belong to). When a guest is added, both an `organisation_members` row (with role `guest`) and a `team_members` row land at the same time. This keeps the "users in this org" query simple and avoids a separate "users without an org row but with a team row" derivation.

## Roles and permissions

Roles are **code-defined and fixed** — the role set and the role-to-capability mapping both live in `src/permissions.ts`, not in the database. Only role _assignments_ — which user holds which role — are stored:

- **Org roles** (`organisation_members.role`): `owner` | `admin` | `member` | `billing` | `guest`.
- **Team roles** (`team_members.role`): `lead` | `member`.

A user may hold any combination, so a composite PK on `(scope, user, role)` lets each grant be one row. A user can be both an `admin` and `billing` in the same org, for example.

Endpoints authorise by **capability**, never by role string. `can(roles, "org:teams:create")` resolves a role set to a boolean against the `OrgAction` / `TeamAction` matrix in `src/permissions.ts`. Team endpoints typically check `can(teamRoles, "team:...") || can(orgRoles, "org:teams:manage")` so org admins can manage any team without needing an explicit team role.

This is deliberate: organisations are not given customisable role sets. The customisable, data-driven permission model is **apps-only** (see below) — Puff's own org/team RBAC stays code-defined so an upgrade can extend it without a data migration.

## Apps & licensing

`apps` is the table of registered OAuth clients. `app_uuid` PK, `app_name`, `client_id` (UNIQUE — the public OAuth identifier), `client_secret` (hashed via `src/utilities/hashing.ts`), `redirect_uris STRING[]` (exact-match allowlist), `app_active` (reversible disable), `app_licensing_mode`, `app_created_at`. **No FK to organisations** — apps are global. Registration is an operator action via direct DB access until the operator UI lands; see [Operations.md → Registering a new app](Operations.md#registering-a-new-app).

Every app declares a **licensing mode** at registration (`app_licensing_mode`, CHECK-constrained):

| Mode       | Meaning                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`     | No licensing checks. Any user with consent can use the app.                                                                                                                             |
| `seat`     | A user is licensed iff `license:tier` resolves to a value via the KV resolver chain (so a tier set on the user, or inherited from a role / team / org). The value is the tier name.     |
| `usage`    | Any org member is licensed; metering happens out of band (the app reports usage back to the operator for Phase 8 billing).                                                              |
| `floating` | A per-org pool of N concurrent seats. Pool size in `license:floating:max`. `app_floating_sessions` tracks current allocations; OAuth `/token` allocates on every code/refresh exchange. |

The mode picks the gating semantics; the entitlement _values_ live in the KV store (see below). Org admins manage grants under `functions/api/organisations/[org_uuid]/apps/[app_uuid]/...`, gated by `org:entitlements:write`.

## The key-value store and the resolver chain

Phase 6 introduced a unified key-value store. One table per **subject** type, each row carrying a first-class **owner** dimension — so org A's data about user U and app B's data about user U coexist as different rows.

Six subject tables:

| Subject      | Table                     | Subject FK                 |
| ------------ | ------------------------- | -------------------------- |
| user         | `user_key_values`         | `user_uuid → users`        |
| team         | `team_key_values`         | `team_uuid → teams`        |
| organisation | `organisation_key_values` | `org_uuid → organisations` |
| org role     | `org_role_key_values`     | `(org_uuid, role)`         |
| team role    | `team_role_key_values`    | `(team_uuid, role)`        |
| app          | `app_key_values`          | `app_uuid → apps`          |

Each has the same shape: subject FK(s) (NOT NULL, CASCADE) + `kv_key`/`kv_value` + three nullable owner FKs (`owner_user_uuid` / `owner_org_uuid` / `owner_app_uuid`, all CASCADE) + computed STORED `owner_id = COALESCE(...)` + a CHECK that exactly one owner is set. PK includes `owner_id`, so the unique tuple is `(subject, owner, key)`.

**The resolver chain.** `src/keyvalues-resolver.ts`'s `resolveKeyValue` walks the most-specific-first chain, filtered by the `owner` namespace:

```text
user → team-role → org-role → team → org → app
```

The `app` tier only fires when `owner.type === "app"` — it represents the app's own default for any user that touches it, the final fallback when every more-specific tier missed. For non-app owners, the chain terminates at `org`.

When a user holds multiple roles in the same tier (e.g. both `owner` and `billing` in an org), the role tier merges + de-duplicates: values from any role count, and roles do not override each other within a tier. By design — granular permissions are stored as separate keys (`perm:read`, `perm:write`), not as competing values on the same key.

The resolver returns `{ values: string[], source }` so callers know both _what_ was found and _which tier_ it came from.

## Entitlements

Entitlements are KV rows under an app's owner namespace. There is no separate `app_user_grants` schema — the KV store is the entitlement store.

Reserved keys under the app owner:

- `license:tier` — the user's tier (on user / team / org subject under app owner). Used by `seat` mode.
- `license:tiers:<name>` — the menu of available tiers (on the app's self-owned subject, i.e. `app` subject + `app` owner). Operator-set, not user-grantable.
- `license:perms:<name>` — app-declared permission identifiers (app subject, app owner). Operator-set.
- `license:floating:max` — per-org pool size (org subject under app owner), with a fallback to the app's self-owned default (app subject, app owner). Used by `floating` mode.
- `perm:<name>` — the actual permission grants (user / team / org subject under app owner). The values are the granted permissions, resolved through the chain.

The `validateEntitlementKey` helper in `src/utilities/entitlements-endpoint.ts` enforces the namespace at the API layer — only `license:tier` and `perm:*` are user-grantable through the org endpoints; the `license:tiers:*` / `license:perms:*` schema keys are operator-only.

**Grantee-in-org constraint.** `assertGranteeInOrg` (`src/entitlements.ts`) 404s any user/team grantee that isn't part of the granting org. Apps are global, so the constraint is "grantee belongs to the granting org", not "grantee belongs to the app's org".

**"Licensed" definition.** `isLicensed(dbClient, app, user, org)` branches on `app_licensing_mode`:

- `none` → always licensed.
- `usage` → licensed iff the user is a member of the org.
- `seat` → `license:tier` resolves to a non-null value via the standard chain.
- `floating` → a live `app_floating_sessions` row exists for `(app, org, user)`.

`summariseLicensing` produces the per-org billing readout (assigned vs. active vs. pool max).

## How it all composes

A typical end-to-end flow: an OAuth client (an "app") needs to log a user in.

1. The app redirects the user to `/oauth/authorize?client_id=…&org_uuid=…&scope=…`.
2. Puff's `/authorize` validates the client + redirect_uri + PKCE, verifies the session (redirecting to `/login` if needed), and resolves the org context (auto-bound if there's one match, picker rendered if several).
3. `oauth_consents` is checked — if the requested scopes are already remembered, the consent screen is skipped.
4. On approval, `oauth_grants` gets an `authorization_code` row bound to `(user, app, org_uuid)`.
5. The app exchanges the code at `/oauth/token`, getting an access token (JWT) + ID token + optional refresh token. The JWT bakes in `org_uuid` so downstream services know which entitlements apply.
6. The app calls `/userinfo` with the access token — Puff verifies the JWT signature, reads the scopes from the `scope` claim, and returns `{ sub, name?, email?, email_verified? }` plus any Puff-specific claims (`puff:memberships`, `puff:roles`, `puff:entitlements`) the scopes earned.

Behind that:

- The user's session was established by one of password / passkey / federated provider (see [Architecture.md → Federated login](Architecture.md#federated-login-puff-as-client)).
- Their `puff:roles` claim comes from `organisation_members` + `team_members` for the bound `org_uuid`.
- Their `puff:entitlements` claim is resolved via the KV chain in [The key-value store and the resolver chain](#the-key-value-store-and-the-resolver-chain) — most-specific entitlement wins.
- Each step that mutated state (login, consent, grant issue) emitted an audit event through `src/hooks/`; the audit row carries actor IP and user-agent for forensics.

Every entity in the hierarchy is reachable by uuid, every relationship is enforced by FK (or deliberately not, in the audit case), and every change is logged.
