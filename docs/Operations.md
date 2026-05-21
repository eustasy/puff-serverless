# Operations

Tasks that need doing intermittently — not on every deploy, but as part of running Puff in production. For the codebase shape see [Architecture.md](Architecture.md); for the data model see [Hierarchy.md](Hierarchy.md); for shipping see [Deployment.md](Deployment.md).

## Table of Contents

- [Scheduled cleanup](#scheduled-cleanup)
- [Audit events & hooks](#audit-events--hooks)
  - [What gets audited](#what-gets-audited)
  - [Reading the audit log](#reading-the-audit-log)
  - [Adding a new listener](#adding-a-new-listener)
- [OAuth signing-key rotation](#oauth-signing-key-rotation)
- [Registering a new app](#registering-a-new-app)
- [Adding a federated login provider](#adding-a-federated-login-provider)
  - [GitHub](#github)
  - [Google](#google)
  - [Microsoft](#microsoft)
  - [Pushing credentials to Cloudflare](#pushing-credentials-to-cloudflare)
- [Security concerns](#security-concerns)

## Scheduled cleanup

The request path only ever _soft_-expires data: sessions are marked inactive, tokens marked used, TOTP codes recorded — nothing is deleted inline. A [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) reaps that data instead.

The schedules are declared as `triggers.crons` in `wrangler.jsonc`; the `scheduled` handler is added by `worker.ts` and the job itself is `src/cron.ts`. That module is the one DB caller with no `_middleware.ts` in front of it, so it opens and closes its own `pg` client.

| Schedule      | Action                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*/5 * * * *` | Purge `totp_used_codes` rows past the TOTP acceptance window. Runs often so a stale row cannot collide with a later, legitimately-different code. Also reaps `app_floating_sessions` past their `expires_at`.                |
| `0 * * * *`   | Additionally purge `sessions` and `tokens` older than one month (kept that long as a lightweight audit trail), and `audit_events` rows of severity `debug` / `info` older than 90 days. `notice` and above are kept forever. |

Sessions are purged only when also defunct (inactive or past expiry), so a still-valid session is never deleted even if `SESSION_MAX_AGE_SECONDS` is raised beyond a month.

To watch the cron firing in production, `wrangler tail` will show the summary line each run prints (`Scheduled cleanup (*/5 * * * *): purged N TOTP codes, N floating seats.` and the hourly variant including sessions / tokens / audit-events counts).

## Audit events & hooks

Account and organisation actions emit structured events through `src/hooks/`. The default listener writes a row to `audit_events`; the same dispatcher is the extension point for future listeners — webhook delivery, SIEM forwarding, real-time UI fanout — without touching the call sites.

### What gets audited

Every event is one of the named constants in `src/hooks/events.ts`. Account events (`account.*`) cover registration, login success/failure, logout, email changes, password changes and resets, 2FA setup and disable, passkey deletion, and external-identity link/unlink. Organisation events (`org.*`) cover create/update/enable/disable/delete, member add/invite/remove/role-change, invitation accept/revoke, team CRUD and team-member management, and entitlement set/remove at org/team/user grain.

Every event has a default severity (`debug` < `info` < `notice` < `warning` < `alert` < `critical`) baked into `DEFAULT_SEVERITY` in the same file. Tiering rule of thumb:

- **`info`** — routine, expected, high-volume (logins, verification resends).
- **`notice`** — meaningful state change (member added, email changed, team created).
- **`warning`** — failed attempt or suspicious action (failed login).
- **`alert`** — security-sensitive change (password change, 2FA disabled, org deleted).

Severities are codified centrally so adding a new event without assigning one is a typecheck error. Override per call site via the `event_severity` field on the emit payload when the context warrants escalation.

### Reading the audit log

`audit_events` is plain SQL. Useful queries:

```sql
-- Recent activity for a user
SELECT created_at, event_type, event_outcome, target_label, event_metadata
FROM audit_events
WHERE actor_user_uuid = '<uuid>'
ORDER BY created_at DESC
LIMIT 50;

-- Everything that's ever happened to a user (as target)
SELECT created_at, event_type, actor_user_uuid, event_metadata
FROM audit_events
WHERE target_user_uuid = '<uuid>'
ORDER BY created_at DESC;

-- Failed-login bursts in the last hour (potential brute-force)
SELECT actor_ip, COUNT(*) AS attempts, MAX(created_at) AS latest
FROM audit_events
WHERE event_type = 'account.login.failed'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY actor_ip
HAVING COUNT(*) > 10
ORDER BY attempts DESC;

-- Org-wide membership history
SELECT created_at, event_type, actor_user_uuid, target_user_uuid, event_metadata
FROM audit_events
WHERE target_org_uuid = '<org_uuid>'
  AND event_type LIKE 'org.member.%'
ORDER BY created_at DESC;
```

**Deleted referents.** The uuid columns are deliberately FK-less — an audit row exists precisely to remember an action against a specific user / org / team / app, so it must outlive the referent. Reporting code joins with `LEFT JOIN` and treats unresolved uuids as "deleted". The `target_label` column snapshots a human-readable handle (email, role name, team name) at write time, so most reports don't need the join at all.

**Retention.** Tiered by severity (`debug` / `info` reaped after 90 days, `notice` and above kept forever) — see [Scheduled cleanup](#scheduled-cleanup) above.

### Adding a new listener

The hooks dispatcher (`src/hooks/dispatch.ts`) walks a registry of listeners on every emit. Each listener declares a `kind`:

| `kind`  | When                                                                                               | Failure                                                               |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `sync`  | Awaited before the dispatcher returns. The audit listener is `sync` so the row exists on response. | Propagates — the handler's `try/catch` surfaces it (typically a 500). |
| `async` | Queued via `ctx.waitUntil`; runs after the response is sent. Best-effort.                          | Logged via `console.error`, never affects the response.               |

Two lines of work to add one:

1. Create `src/hooks/listeners/<name>.ts` exporting an object that satisfies `HookListener` (a `name`, a `kind`, an optional `filter`, and a `handle(dbClient, event)` async function).
2. Import it and append to the array in `src/hooks/registry.ts`.

A `filter: (event) => boolean` restricts which events the listener sees. A webhook listener that only cares about org membership changes might filter to `event.event_type.startsWith("org.member.")`.

Examples worth thinking about:

- **Webhook delivery**: `kind: 'async'`, reads per-org webhook URLs from a future subscription table, POSTs the event.
- **Console structured-logger**: `kind: 'async'`, wraps `console.log` with a JSON envelope so log aggregators can parse it.
- **Real-time admin dashboard**: `kind: 'async'`, pushes to a Durable Object that fans out to connected admins.

## OAuth signing-key rotation

The OAuth provider signs ID tokens and access tokens with an ES256 (ECDSA P-256) keypair. The private key lives in the `OAUTH_SIGNING_KEY_PRIVATE` secret; the matching public key is derived at runtime, exposed via `/.well-known/jwks.json`, and identified by an RFC 7638 thumbprint `kid` (so the kid is deterministic from the key — no separate binding).

Rotation is **a manual operator action** — there is no cron job that rotates keys on its own. The overlap window during rotation is what keeps already-issued JWTs valid until they expire.

**First-time setup** (or rotation):

1. Generate a fresh keypair:

   ```sh
   node scripts/generate-oauth-key.mjs
   ```

   The script prints the private JWK (a single-line JSON string), the public JWK with its `kid`, and the exact `wrangler secret put` command to run.

2. _(Rotation only — skip on first setup.)_ Copy the **previous** public JWK (the `kty` / `crv` / `x` / `y` fields, without `kid` / `use` / `alg` / `d`) into the `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC` binding via the dashboard or `wrangler secret put`. This keeps JWTs signed by the retired key validating in JWKS during the overlap window.

3. Push the new private JWK:

   ```sh
   echo '<the printed private JWK>' | npx wrangler secret put OAUTH_SIGNING_KEY_PRIVATE
   ```

4. For local development, set the same JWK in `.env` as `OAUTH_SIGNING_KEY_PRIVATE`.

5. After the longest-lived JWT has expired (the access-token / ID-token lifetime — order of an hour), clear `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC`:

   ```sh
   npx wrangler secret delete OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC
   ```

`/.well-known/jwks.json` exposes the active public JWK and, while the previous-public binding is set, the retired one alongside it. Clients fetching JWKS will validate JWTs against both during the overlap.

## Registering a new app

"App" here means an OAuth client — a downstream service that logs its users in with Puff. Until the operator UI lands (Phase 7 follow-up), registration is direct DB access. Apps are **globally registered**, not org-owned — any org can grant its users entitlements for any registered app (see [Hierarchy.md → Apps & licensing](Hierarchy.md#apps--licensing)).

1. **Pick a client_id.** It must be unique across all apps. Convention: a short, hostname-like identifier (e.g. `my-app`).
2. **Generate a client_secret.** Any high-entropy random string is fine — 32+ bytes base64-encoded works. Save the plaintext; you'll hand it to the app's operator and never see it again (Puff stores only the hash).
3. **Hash the secret** using Puff's hashing module:

   ```sh
   # From a Node REPL in the repo root:
   node --input-type=module -e "
     import('./src/utilities/hashing.js').then(async ({ puff_hashing_password, PREFERRED_PASSWORD_ALGO }) => {
       const hash = await puff_hashing_password('<the plaintext secret>')
       console.log(hash)
     })
   "
   ```

   The output is the hash string to store. **Don't store the plaintext anywhere.**

4. **Insert the row.** All apps must declare a licensing mode at registration — one of `'none'`, `'seat'`, `'usage'`, `'floating'`. See [Hierarchy.md → Apps & licensing](Hierarchy.md#apps--licensing) for what each mode means.

   ```sql
   INSERT INTO apps (
     app_uuid, app_name, client_id, client_secret,
     redirect_uris, app_active, app_licensing_mode
   )
   VALUES (
     gen_random_uuid(),
     'My App',
     'my-app',
     '<the hash from step 3>',
     ARRAY['https://my-app.example.com/oauth/callback'],
     TRUE,
     'none'
   )
   RETURNING app_uuid;
   ```

5. **(For `seat` / `floating` modes only)** Seed the app's self-owned defaults — the tiers it offers, the perms it declares, the default floating-pool size. These live in `app_key_values` as `(subject = app, owner = app, key = …)`:

   ```sql
   INSERT INTO app_key_values (app_uuid, owner_app_uuid, kv_key, kv_value)
   VALUES
     ('<app_uuid>', '<app_uuid>', 'license:tiers:basic', 'Basic'),
     ('<app_uuid>', '<app_uuid>', 'license:tiers:pro', 'Pro'),
     ('<app_uuid>', '<app_uuid>', 'license:perms:read', 'Read access'),
     ('<app_uuid>', '<app_uuid>', 'license:perms:write', 'Write access'),
     ('<app_uuid>', '<app_uuid>', 'license:floating:max', '10');
   ```

6. **Hand the credentials to the app's operator** — `client_id` (public) + `client_secret` (the plaintext from step 2, **once**).

Org admins can now grant entitlements for the app under `functions/api/db/auth/organisations/[org_uuid]/apps/[app_uuid]/...`, gated by `org:entitlements:write`. The app authenticates against `/oauth/token` with HTTP Basic or body params and uses the standard OAuth 2.1 Authorization Code + PKCE flow ([Architecture.md → OAuth 2.1 / OIDC endpoints](Architecture.md#oauth-21--oidc-endpoints-puff-as-provider)).

To disable an app, set `app_active = FALSE`. The change is reversible and doesn't cascade — existing grants stay in place but new authorization requests are rejected.

## Adding a federated login provider

The provider buttons on `public/login.html` and `public/account.html` are HTMX-loaded from `/api/providers` — a no-DB, no-auth endpoint that calls `listConfiguredProviders(env)` and returns buttons only for providers with both `OAUTH_<PROVIDER>_CLIENT_ID` and `OAUTH_<PROVIDER>_CLIENT_SECRET` set. An unconfigured provider does not appear; an empty response (zero providers) collapses the section entirely.

To enable one, three things have to line up: an app registration at the provider, a pair of secrets pushed to Cloudflare, and the schema imported into the database (the federated-login tables are already imported in the production deploy — see [Deployment.md → Provision the database](Deployment.md#1-provision-the-database)).

**Redirect URI** — every provider needs the exact callback URL Puff will return to, derived from `APP_URL`:

```
${APP_URL}/login/<provider>/callback
```

Localhost and production are separate registrations (the URI must match exactly), so register a "dev" app pointing at `http://localhost:8788/login/<provider>/callback` and a separate "prod" app pointing at your deployed URL.

### GitHub

1. **Register the OAuth App** — [Settings → Developer settings → OAuth Apps → New OAuth App](https://github.com/settings/developers).
   - **Application name**: anything (shown to users on the consent screen).
   - **Homepage URL**: your `APP_URL`.
   - **Authorization callback URL**: `${APP_URL}/login/github/callback`.
2. **Generate a client secret** — on the app's page, _Generate a new client secret_. Copy it once; GitHub never shows it again.
3. **Note the Client ID** — shown on the same page.
4. Scopes are requested at authorize-time (`read:user user:email`) — no per-app scope configuration on GitHub's side.

### Google

1. **Configure the OAuth consent screen** first — Google requires it before any credential will work. [Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent). Set User Type to External (or Internal for a Workspace tenant), fill in the app name + support email, and add the `openid`, `email`, and `profile` scopes.
2. **Create an OAuth 2.0 Client ID** — [Credentials → Create Credentials → OAuth client ID](https://console.cloud.google.com/apis/credentials). Application type: **Web application**.
   - **Authorised redirect URIs**: `${APP_URL}/login/google/callback`.
3. **Copy the Client ID + Client Secret** from the credential's details page.
4. While the consent screen is in Testing mode, only the test users you list can sign in; submit it for verification before going public.

### Microsoft

1. **Register the application** — [Azure Portal → App registrations → New registration](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade).
   - **Supported account types**: _Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)_ — this is what matches the `https://login.microsoftonline.com/common/...` endpoints Puff uses.
   - **Redirect URI**: platform **Web**, URI `${APP_URL}/login/microsoft/callback`.
2. **Generate a client secret** — _Certificates & secrets → Client secrets → New client secret_. Copy the **Value** (not the Secret ID) immediately; Azure hides it on the next page load.
3. **Copy the Application (client) ID** — shown on the Overview page.
4. **API permissions** — Microsoft Graph → Delegated → add `openid`, `email`, `profile` (already present by default for a fresh registration; verify they are there).

Microsoft's `/oidc/userinfo` endpoint deliberately omits the OIDC `email_verified` claim, so Puff reads the `tid` (tenant ID) out of the ID token returned by `/token` instead. A `tid` other than the special personal-MSA tenant (`9188040d-6c67-4c5b-b112-36a304b66dad`) means a work/school tenant where the email is the verified UPN — trusted as `email_verified: true`. Personal MSA accounts (Outlook / Hotmail / Xbox), and any unparseable or missing ID token, stay unverified and land in Puff's standard verification flow.

### Pushing credentials to Cloudflare

For each provider you registered, push the two values as Worker secrets:

```sh
echo "<the client id>"     | npx wrangler secret put OAUTH_GITHUB_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GITHUB_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_GOOGLE_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET

echo "<the client id>"     | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_ID
echo "<the client secret>" | npx wrangler secret put OAUTH_MICROSOFT_CLIENT_SECRET
```

For local development, put the same values in `.env` (git-ignored). A provider where **either** of its env vars is missing is treated as not configured and its `/login/<provider>` route 404s.

## Security concerns

Operational guardrails worth keeping in mind:

- **Cookie security** — `SECURE_COOKIE=true` and `COOKIE_SAMESITE=Lax` are the production defaults. The cross-origin write guard in `functions/api/db/_middleware.ts` rejects same-site CSRF from sibling subdomains independently of `SameSite`. If you serve Puff alongside other apps on the same parent domain, the guard is what closes the residual gap.
- **Password policy** — at minimum, enforce `MIN_PASSWORD_LENGTH ≥ 12` and turn on `REQUIRE_NOT_COMPROMISED` (HIBP). `REQUIRE_ZXCVBN` is the strongest single setting — score ≥ 3 catches most weak passwords without requiring arbitrary character-class flags.
- **2FA bypass** — the `/api/db/2fa/bypass/request` flow sends a single-use email link to a verified address on the account: the primary if it's verified, otherwise the oldest-verified secondary. Possession of that inbox is the second factor; if an attacker compromises a user's email and their password, 2FA does not save them. The endpoint also refuses to send if a password reset was completed in the last 24 hours — otherwise email alone could reset the password (factor 1) and then bypass 2FA (factor 2). Encourage passkeys (which bind to the device and aren't email-recoverable) for high-value accounts.
- **TOTP replay** — handled by `totp_used_codes` and the 5-minute cron purge. A code is accepted at most once within its 30s validity window; replays within the same window are rejected.
- **OAuth signing key** — the active key is a Wrangler secret. Rotate on a schedule (annually is reasonable) and after any suspected compromise; the overlap-window procedure above keeps in-flight tokens valid through the transition.
- **Audit log** — `notice` and above are retained indefinitely. Use it for incident investigation; the `target_label` column snapshots referents that may later be deleted. Don't store sensitive payloads in `event_metadata` (passwords, full tokens) — it ends up in the audit table verbatim.
- **CSP violation reporting** — `public/_headers` declares a `report-uri` and `Reporting-Endpoints`; violations land at `functions/api/csp-report.ts`, which logs them via `console.warn`. Check `wrangler tail` periodically (or pipe it to a log aggregator) to spot misconfigurations or attacks.
- **Schema changes** — keep additive. The audit table outlives its referents because the FK constraints were deliberately omitted; any schema change that adds FKs to existing append-only data should be reviewed carefully.
