---
applyTo: "**"
---

# Architecture Instructions

Terse reference for AI tooling. Long-form prose lives in `docs/Architecture.md`, `docs/Hierarchy.md`, and the sibling instruction files in this directory.

## General Guidelines

* **Scalability**: design components to handle massively concurrent workloads.
* **Documentation**: document components with unclear interactions or intentions inline; long-form goes in `docs/`.
* **Modularity**: code is modular and reusable.

## Structure

* `functions/api/` — dynamic endpoints, directory-routed by Cloudflare Pages Functions.
  * Organised by domain: `functions/api/db/user/`, `functions/api/db/auth/email/`, `functions/api/db/auth/2fa/`, `functions/api/db/auth/password/`, `functions/api/db/auth/passkeys/`, `functions/api/db/auth/external-identities/`, `functions/api/db/auth/organisations/`, `functions/api/db/2fa/`, `functions/api/db/password/`, `functions/api/db/passkeys/`, `functions/api/db/federated-signup/`.
  * `functions/api/` (no `db/` prefix) — endpoints needing neither DB nor auth (`functions/api/providers.ts`, `functions/api/password/requirements.ts`, `functions/api/csp-report.ts`).
  * `functions/api/db/` — needs a DB connection. `functions/api/db/_middleware.ts` opens a Hyperdrive `pg` client into `context.data.dbClient`, closes it in `finally`. The middleware also runs a cross-origin write guard (rejects state-changing requests where `Sec-Fetch-Site !== same-origin`).
  * `functions/api/db/auth/` — additionally requires an authenticated session. `functions/api/db/auth/_middleware.ts` reads the `session_token` cookie, calls `verifyTokenAndGetUser`, and populates `context.data.user_uuid`.
  * Beneath `[org_uuid]/` and `[team_uuid]/`, further middleware files resolve the caller's role set into `context.data.orgRoles` / `context.data.teamRoles`. Inside `apps/[app_uuid]/`, `context.data.app` holds the resolved app row.
* `functions/` (outside `api/`) — Pages-Function-rendered HTML pages: `functions/_middleware.ts` (root page-cookie gating), `functions/organisations/[org_uuid].ts`, `functions/invite.ts`, `functions/federated-signup.ts`, `functions/sitemap.xml.ts`, `functions/login/[provider]/index.ts` + `callback.ts`, `functions/oauth/{authorize,token,userinfo}.ts`, `functions/.well-known/{openid-configuration,jwks.json}.ts`.
* `public/` — static files served by Workers Static Assets.
  * HTML: `index.html`, `login.html`, `register.html`, `logout.html`, `account.html`, `2fa.html`, `password-upgrade.html`, `reset/request.html`, `reset/set.html`.
  * CSS: `assets/main.css`.
  * Client-side JS: `assets/htmx_2.0.4.min.js` (HTMX), `assets/webauthn.js` (small passkey helpers using raw `navigator.credentials`).
  * Images: `assets/bars.svg` (HTMX loading indicator), `favicon.ico`.
  * `_headers` (security headers, CSP, HSTS, Reporting-Endpoints), `_redirects`, `robots.txt`.
* `src/` — backend logic, one module per domain. All exports take `dbClient: DbClient` as their first parameter.
  * **Users / auth / sessions**: `users.ts`, `sessions.ts`, `passwords.ts`, `emails.ts`, `tokens.ts`, `2fa.ts`, `passkeys.ts`.
  * **External identity & federated login**: `external-identities.ts`, `federated-signup-tokens.ts`, `oauth-providers.ts`, `oauth-outbound.ts`.
  * **OAuth / OIDC provider**: `apps.ts`, `oauth.ts`, `oauth-grants.ts`, `oauth-consents.ts`, `oauth-claims.ts`, `oauth-jwt.ts`, `oauth-keys.ts`.
  * **Multi-tenancy**: `organisations.ts`, `teams.ts`, `memberships.ts`, `invitations.ts`, `permissions.ts` (code-defined roles + `can()` capability matrix).
  * **Key-value store** (six subject tables): `user-keyvalues.ts`, `team-keyvalues.ts`, `organisation-keyvalues.ts`, `org-role-keyvalues.ts`, `team-role-keyvalues.ts`, `app-keyvalues.ts`; the inheritance resolver in `keyvalues-resolver.ts`.
  * **App licensing & entitlements**: `entitlements.ts`, `app-floating-sessions.ts`.
  * **Outbound email**: `mailer.ts`, `email-templates.ts`.
  * **Scheduled work**: `cron.ts` runs Worker-side periodic tasks only (currently OAuth signing-key rotation via `oauth-keys-rotation.ts`, on a daily cron that rotates weekly). Pure-SQL row reaping (sessions, tokens, TOTP, floating-sessions, audit) lives in CockroachDB itself via `sql/schedules.sql`. `runScheduledCleanup` in `cron.ts` is retained as a manually-callable fallback.
  * **Hooks / audit**: `src/hooks/` — `dispatch.ts`, `events.ts`, `registry.ts`, `types.ts`, `listeners/audit.ts`. Account/org actions emit through `emitFromContext`; the default listener writes to `audit_events`.
* `src/utilities/` — shared helpers:
  * `hashing.ts` (SHA-384 password hashing with salt, SHA-1 prefix for HIBP).
  * `headers.ts` (`getCookie`, header-parsing helpers).
  * `escape.ts` (`escapeHtml` for interpolating user-controlled values into HTML).
  * `responses.ts` (`resultPositive`, `resultNegative`, `htmlResponse`, `methodNotAllowed`).
  * `transaction.ts` (`runInTransaction`, `Rollback` — handles SERIALIZABLE retries).
  * `login-response.ts` (login-flow outcome routing).
  * `oauth-state-cookie.ts` (federated-login state + PKCE cookie).
  * `next.ts` (`login_next` cookie helpers for post-login redirect).
  * `entitlements-endpoint.ts`, `keyvalues-endpoint.ts`, `keyvalues-shared.ts` (KV / entitlement endpoint plumbing).
* `sql/` — CockroachDB schema, one file per table. Import order: see `docs/Deployment.md` (`users.sql` first; then organisations/teams/members/invitations; then `apps.sql`; then the six `*_key_values.sql`; then `oauth_grants.sql` / `oauth_consents.sql`; then `app_floating_sessions.sql`; then `external_identities.sql` / `federated_signup_tokens.sql`; then per-user tables; `audit_events.sql` has no FK dependencies and can land any time).

## API Design

* The API is primarily consumed by HTMX from static HTML pages.
* API endpoints **return HTML fragments designed for HTMX swapping** — not JSON.
* Avoid returning JSON unless explicitly requested or for OAuth endpoints (`/oauth/token`, `/oauth/userinfo`, `/.well-known/*`) which follow the OAuth 2.1 / OIDC specs.
* Utilise HTMX response headers:
  * `HX-Redirect` for HTMX-driven client-side navigation: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/login?message=Success." } })`. Endpoints reached via direct browser navigation (e.g., a link clicked from an email) need a standard `Location` header instead — `HX-Redirect` is ignored outside HTMX. Branch on `context.request.headers.get("HX-Request") === "true"` to pick the right one; see `functions/api/db/email/verify.ts`.
  * `HX-Trigger` to fire client-side events that refresh other page sections (e.g., `"emailListChanged"`, `"sessionListChanged"`, `"tfaStatusChanged"`, `"passkeysChanged"`, `"organisationsChanged"`, `"organisationMembersChanged"`, `"teamsChanged"`, `"teamMembersChanged"`, `"organisationInvitationsChanged"`, `"externalIdentitiesChanged"`, `"appEntitlementsChanged"`).
  * `HX-Retarget` to redirect an error response to a different DOM target than the form's default.
* Stateless: each request must contain all necessary information (cookies, form fields, query params).
* Use appropriate HTTP status codes (200, 201, 202, 303, 400, 401, 403, 404, 405, 409, 500, 502).
* Reference table schemas in `sql/*.sql` files when designing database interactions.

## General Instructions

These instructions are to avoid unwanted AI activity:

* Do not add small comments for simple code changes (e.g., `// Import the new function`).
* Do not add comments that are obvious from the code itself.
* Do not return JSON from API endpoints unless explicitly requested or the endpoint is OAuth/OIDC.
* Do not check for conditions already handled by preceding middleware (database connectivity, authentication, role resolution, cross-origin write guard).
* **Input Validation**: perform input validation (form data, query parameters, headers) at the beginning of API endpoint handlers, before any database call.
* **Database Connectivity**:
  * Access the database client via `const dbClient = context.data.dbClient` in API handlers, relying on `functions/api/db/_middleware.ts` to provide it.
  * Do not create new database connections in API handlers or `src` functions (exception: `src/cron.ts` opens its own — it runs outside the middleware chain).
* **Authentication**:
  * Access the authenticated user via `const user_uuid = context.data.user_uuid` in API handlers under `functions/api/db/auth/`.
  * Do not re-authenticate in API handlers or `src` functions.
* **Authorisation**:
  * Org/team endpoints authorise via `can(roles, "scope:action")` from `src/permissions.ts`, never on raw role strings.
  * The `[org_uuid]` middleware sets `context.data.orgRoles`; the `[team_uuid]` middleware sets `context.data.teamRoles`. Team endpoints typically combine: `can(teamRoles, "team:…") || can(orgRoles, "org:teams:manage")`.
* **Response Handling**:
  * **Success**: `return new Response('<p class="result-positive">Success!</p>', { headers: { "Content-Type": "text/html" } })`. Use `resultPositive(...)` from `src/utilities/responses.ts` for the common shape.
  * **Redirects**: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/target" } })`.
  * **Errors**: `return new Response('<p class="result-negative">Error message.</p>', { status: 400, headers: { "Content-Type": "text/html" } })`. Use `resultNegative(...)` for the common shape.
  * **Refresh triggers**: include `"HX-Trigger": "eventName"` header to refresh related page sections.
* **Audit emissions**: account and organisation mutations emit a structured event via `emitFromContext(context, { event_type: EVENTS.X, ... })` from `src/hooks/dispatch.js` after the mutation succeeds. The default listener writes to `audit_events`. See `docs/Operations.md → Audit events & hooks`.
* **Function Naming**: Cloudflare Pages Functions export `onRequestGet`, `onRequestPost`, etc. for specific methods. Export a catch-all `onRequest` that returns 405 with an `Allow` header for unsupported methods (or use `methodNotAllowed("POST")` from `src/utilities/responses.ts`).
* **Middleware Chaining**: database middleware runs before auth middleware. Auth middleware depends on `context.data.dbClient` being populated. Org/team middleware (under `organisations/[org_uuid]/...`) runs after auth and depends on `context.data.user_uuid`.
