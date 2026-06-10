# Flatten API Middleware Tiers

Plan to remove the `db` and `auth` segments from public API URLs (`/api/db/auth/email/list`
→ `/api/email/list`) by replacing **directory-depth middleware tiering** with a single
`functions/api/_middleware.ts` driven by a **route-policy table**. Drafted 2026-06-09.

This is a structural refactor, not a behaviour change: the same four request-handling
tiers (cross-origin guard → DB → session auth → operator gate) run exactly as today;
only their *selector* changes from folder position to a lookup.

## Table of Contents

- [Why the strings are there](#why-the-strings-are-there)
- [The constraint](#the-constraint)
- [The design](#the-design)
  - [Fail-safe default](#fail-safe-default)
  - [Internal vs external CORS](#internal-vs-external-cors)
  - [Extract the tier functions](#extract-the-tier-functions)
  - [The composed middleware](#the-composed-middleware)
- [Migrated endpoint example](#migrated-endpoint-example)
- [Blast radius](#blast-radius)
- [Execution plan](#execution-plan)
  - [Sequencing: the new middleware is not inert](#sequencing-the-new-middleware-is-not-inert)
  - [Stages](#stages)
  - [Dependency graph](#dependency-graph)
  - [Models and effort](#models-and-effort)
- [Trade-offs and risks](#trade-offs-and-risks)
- [Rejected alternatives](#rejected-alternatives)
- [Out of scope](#out-of-scope)

## Why the strings are there

The `db` and `auth` path segments are **load-bearing**, not cosmetic. Cloudflare Pages
Functions has exactly one mechanism for scoping middleware: directory nesting. A
`_middleware.ts` runs for its folder and every descendant, and the chain composes by
depth. The three tiers are therefore *encoded as path segments*:

| Path | What the segment buys you | Source |
| --- | --- | --- |
| `functions/api/…` | cross-origin guard only | (root `_middleware.ts`) |
| `functions/api/db/…` | + `pg` client on `context.data.dbClient` | `functions/api/db/_middleware.ts` |
| `functions/api/db/auth/…` | + `user_uuid` from the session cookie | `functions/api/db/auth/_middleware.ts` |
| `functions/api/db/auth/admin/…` | + operator-UUID gate | `functions/api/db/auth/admin/_middleware.ts` |

The strength of this scheme is that it is *physically impossible* to put a handler in
the auth tier without it being authed — placement **is** the policy. The costs are (1)
the tier names leak into every public URL, and (2) the failure mode is **unsafe**: drop
a file one level too shallow and it silently loses authentication.

There is already a crack in the model: `functions/api/billing/` needed DB-but-not-auth,
so it spun up a *parallel* branch using the `createDbMiddleware("/api/billing")` factory
(`src/utilities/db-middleware.ts`) rather than fitting the tree. That factory is proof
the team is already comfortable parameterising middleware instead of relying purely on
directory position.

## The constraint

You **cannot** keep the ugly tree behind a pretty URL via a rewrite. Pages resolves the
route to a function module *around* the middleware chain; `context.next(newRequest)`
only changes the static-asset fallthrough, not which `.ts` handler is selected. The
pretty URL has to be the real directory path. So the only way to drop the segments is to
**stop using directory nesting as the middleware selector** — which is what this plan does.

## The design

Flatten the tree so the directory path is the clean public path, and replace the four
`_middleware.ts` files (plus the parallel `billing/` one) with a single
`functions/api/_middleware.ts`. Tier is no longer position — it is a lookup against a
route-policy table.

Critically, the new file does **not** re-implement the tier logic. Each tier is already
(or becomes) a self-contained function — the existing `createDbMiddleware` factory plus
siblings extracted from today's middleware bodies — and the new `_middleware.ts`
**composes those by reference**, conditionally per policy. Same functions the four
middleware files run today; we relocate them, we do not merge their bodies into one blob.
The one place we *add* behaviour is the cross-origin tier, which splits into an internal
(first-party, anti-CSRF) and an external (third-party CORS) guard — see
[Internal vs external CORS](#internal-vs-external-cors).

```text
BEFORE                                          AFTER
functions/api/                                  functions/api/
  providers.ts            (public, no db)         providers.ts            ← unchanged tier
  password-requirements.ts                        password-requirements.ts
  db/                                            email/
    user/exists.ts        (db, no auth)            verify.ts             ← was db/email/verify
    user/login.ts                               user/
    password/request.ts                           exists.ts             ← was db/user/exists
    auth/                                          login.ts
      email/list.ts       (db + auth)            password/
      organisations/…                              request.ts            ← was db/password/request
      admin/              (db + auth + operator)  email/
        oauth-keys/…                               list.ts               ← was db/auth/email/list
                                                  organisations/…         ← was db/auth/organisations
                                                  admin/                  ← was db/auth/admin
                                                    oauth-keys/…
```

### Fail-safe default

The policy table's **default for any unlisted `/api/*` path is the most-protected tier**
(`{ db: true, auth: true }`). The two enumerated sets are the *explicit opt-outs*; the
`admin/` prefix is the one stricter opt-in. Consequences:

- A new endpoint someone forgets to register is **locked down**, not exposed — the
  inverse of today's unsafe failure mode.
- Forgetting to list a genuinely public endpoint over-protects it (annoying, visible in
  testing) rather than under-protecting a private one (a hole). This asymmetry is the
  whole point.

Public carve-outs are matched by **exact path** (a `Set`), never prefix: no dynamic
segment appears in any public route, and a prefix like `/api/organisations` would
wrongly swallow `/api/organisations/create` (auth-required). The two prefix matches are
the stricter operator opt-in (`/api/admin/`) and the external-CORS opt-in
(`/api/billing/`), both of which are whole sub-trees, not individual leaves.

### Internal vs external CORS

The single same-origin guard today silently serves two populations with opposite needs,
so it splits into two functions selected by the policy's `cors` field:

- **`sameOriginWriteGuard`** (internal, the default — today's logic verbatim). First-party
  HTMX endpoints authenticated by the ambient `session_token` cookie. Because the
  credential is ambient, these are CSRF-able, so state-changing methods **must** be
  same-origin (`Sec-Fetch-Site: same-origin`, `Origin` fallback). This is a *block*, not
  CORS proper — it adds no `Access-Control-*` headers.
- **`externalCorsGuard`** (external, opt-in for `/api/billing/*`). Third-party callers
  authenticated by a Stripe signature or app token *inside the handler*, never by the
  session cookie. Same-origin enforcement is both **wrong** (they are legitimately
  cross-origin) and **unnecessary** (no ambient credential ⇒ no CSRF vector). Instead this
  is real CORS: it answers the `OPTIONS` preflight and echoes an allowlisted `Origin` onto
  the response, while never blocking on origin.

The split tracks an existing fact: the `/api/billing` tier already runs DB-only with no
session auth, precisely because it is token/signature-authed. `cors: "external"` is just
that property made explicit. **Fail-safe still holds** — the default is the strict
internal guard, so a new endpoint is CSRF-protected unless someone deliberately opts it
into the external tier; mis-marking an internal, cookie-authed endpoint as external is the
one move that would strip its CSRF protection, which is why external is the narrow opt-in.

```ts
// src/utilities/cors.ts  (externalCorsGuard — the net-new half)
export const externalCorsGuard: Handler = async (context) => {
  const { request, env } = context
  const origin = request.headers.get("Origin")
  const allowOrigin = isAllowedExternalOrigin(env, origin) ? origin : null // env allowlist

  // Preflight: route handlers export no onRequestOptions, so answer it here.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) })
  }

  // No ambient cookie ⇒ not a CSRF vector ⇒ never blocked on origin. Stripe is
  // server-to-server (no Origin, nothing to echo); browser callers get the header.
  const response = await context.next()
  if (!allowOrigin) return response
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", allowOrigin)
  headers.append("Vary", "Origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
```

`externalCorsGuard` is also the natural home for `/oauth/userinfo` and friends, which are
cross-origin by nature — out of scope here (separate middleware tree), but a reason to
land the shared util now rather than inline it.

### Extract the tier functions

One tier is already a reusable function — `createDbMiddleware(label)` in
`src/utilities/db-middleware.ts`, which `billing/` calls. The rest are inlined in their
`_middleware.ts` files. Step one is to **extract them into sibling utilities**, so every
tier is an importable `Handler` with a single source of truth:

| New utility | Lifted verbatim from | Exports |
| --- | --- | --- |
| `src/utilities/db-middleware.ts` *(exists)* | — | `createDbMiddleware(label): Handler` |
| `src/utilities/cors.ts` *(new)* | `api/db/_middleware.ts` → `crossOriginWriteGuard` (renamed `sameOriginWriteGuard`); `externalCorsGuard` is **net-new** | `sameOriginWriteGuard: Handler`, `externalCorsGuard: Handler` |
| `src/utilities/session-auth.ts` *(new)* | `api/db/auth/_middleware.ts` → `sessionAuthWithCookie` | `sessionAuthMiddleware: Handler` |
| `src/utilities/operator-auth.ts` *(new)* | `api/db/auth/admin/_middleware.ts` → `operatorAuthorise` | `operatorAuthMiddleware: Handler` |

Every body except `externalCorsGuard` moves unchanged — they already use the shared leaf
helpers (`getCookie`, `verifyTokenAndGetUser`, `unauthorizedResponse`,
`parseOperatorUuids`, `resultNegative`). The lone new behaviour is `externalCorsGuard`
(see [Internal vs external CORS](#internal-vs-external-cors)). A useful side effect:
`api/db/_middleware.ts` currently carries its *own* inline `databaseConnectionMiddleware`,
a second copy of the DB-lifecycle logic that `createDbMiddleware` already implements;
extraction collapses that duplicate, leaving exactly one DB-connection function in the
codebase.

### The composed middleware

`functions/api/_middleware.ts` imports the four tier functions and composes them as a
native Pages middleware array, with each tier wrapped in a thin policy gate that either
delegates to the shared function or passes through:

```ts
import { createDbMiddleware } from "../../src/utilities/db-middleware.js"
import { sameOriginWriteGuard, externalCorsGuard } from "../../src/utilities/cors.js"
import { sessionAuthMiddleware } from "../../src/utilities/session-auth.js"
import { operatorAuthMiddleware } from "../../src/utilities/operator-auth.js"

// ── Route policy ───────────────────────────────────────────────────────────
// DEFAULT for any /api/* path NOT listed below is { db: true, auth: true } —
// the most-protected tier. A new endpoint someone forgets to register here is
// therefore locked down, not exposed. The two sets are the *explicit opt-outs*;
// the OPERATOR prefix is the one stricter opt-in.

// Need neither DB nor a session (today's functions/api/*.ts leaves).
const NO_DB = new Set([
  "/api/providers",
  "/api/password-requirements",
  "/api/messages",
  "/api/csp-report",
])

// Need the DB but no session — login, registration, token-capability flows
// (today's functions/api/db/* non-auth leaves). Exact paths only: no dynamic
// segment appears in a public route, so a Set is enough and a prefix would be
// too greedy (e.g. /api/organisations/create must NOT match here).
const PUBLIC_DB = new Set([
  "/api/user/exists",
  "/api/user/login",
  "/api/user/register",
  "/api/password/request",
  "/api/password/set",
  "/api/password/upgrade",
  "/api/email/verify",
  "/api/2fa/login",
  "/api/2fa/bypass/request",
  "/api/2fa/bypass/verify",
  "/api/passkeys/authenticate/start",
  "/api/passkeys/authenticate/complete",
  "/api/organisations/invitation/view",
  "/api/federated-signup/confirm",
  // NB: /api/billing/* is deliberately NOT here — it is a prefix rule in
  // policyFor (below), because usage/[app_uuid] has a dynamic segment an exact
  // Set entry cannot capture.
])

interface Policy {
  db: boolean
  auth: boolean
  operator: boolean
  cors: "internal" | "external"
}

// CORS trust boundary, orthogonal to db/auth. External = third-party callers
// authenticated by a signature or app token in the handler, NOT the session
// cookie (today's whole /api/billing tier: Stripe webhook + usage API). For
// those the same-origin CSRF block is wrong and unnecessary; everything else
// is first-party HTMX and defaults to the strict internal guard.
const corsModeFor = (pathname: string): "internal" | "external" => (pathname.startsWith("/api/billing/") ? "external" : "internal")

function policyFor(pathname: string): Policy {
  const cors = corsModeFor(pathname)
  // The whole /api/billing subtree is DB-only and token/signature-authed in the
  // handler (Stripe webhook + the dynamic usage/[app_uuid] API), never session-
  // authed. A PREFIX, not a Set entry, because usage/[app_uuid] has a dynamic
  // segment an exact match cannot capture.
  if (pathname.startsWith("/api/billing/")) return { db: true, auth: false, operator: false, cors }
  if (NO_DB.has(pathname)) return { db: false, auth: false, operator: false, cors }
  if (PUBLIC_DB.has(pathname)) return { db: true, auth: false, operator: false, cors }
  if (pathname.startsWith("/api/admin/")) return { db: true, auth: true, operator: true, cors }
  return { db: true, auth: true, operator: false, cors } // fail-safe default
}

const policyOf = (context: { request: Request }): Policy => policyFor(new URL(context.request.url).pathname)

// ── Policy gates: delegate to the shared tier function, or pass through ──────
// createDbMiddleware's try/finally wraps context.next(), so when maybeDb runs
// the DB tier its connection stays open through maybeAuth + maybeOperator + the
// route and is closed afterwards — the same lifecycle the nested tree gave us.
const dbTier = createDbMiddleware("/api")

// Element 0 picks the CORS guard by trust boundary instead of running one
// unconditionally — the internal guard blocks cross-origin writes, the external
// guard permits them and answers preflight (see Internal vs external CORS).
const corsGate: Handler = (context) => (policyOf(context).cors === "external" ? externalCorsGuard(context) : sameOriginWriteGuard(context))

const maybeDb: Handler = (context) => (policyOf(context).db ? dbTier(context) : context.next())
const maybeAuth: Handler = (context) => (policyOf(context).auth ? sessionAuthMiddleware(context) : context.next())
const maybeOperator: Handler = (context) => (policyOf(context).operator ? operatorAuthMiddleware(context) : context.next())

export const onRequest = [corsGate, maybeDb, maybeAuth, maybeOperator]
```

The array runs in order, each element's `context.next()` advancing to the next. Because
`auth` implies `db` and `operator` implies `auth` in `policyFor`, the gates never run a
tier whose prerequisite was skipped (e.g. `sessionAuthMiddleware` always finds
`context.data.dbClient`). `policyFor` is called up to four times per request — trivial;
memoise on `context.data` if it ever shows up. The whole point is that the five imported
functions are byte-for-byte (the external CORS guard, new) what runs today; this file
only chooses *which* run.

## Migrated endpoint example

Handler bodies barely move — `context.data.dbClient!` / `context.data.user_uuid!` are
still populated by the middleware. `functions/api/db/auth/email/list.ts` →
`functions/api/email/list.ts` changes only two things:

```ts
// 1. Import depth shrinks by two levels (the file is shallower now):
- import { readEmails } from "../../../../../src/emails.js"
- import { escapeHtml } from "../../../../../src/utilities/escape.js"
+ import { readEmails } from "../../../src/emails.js"
+ import { escapeHtml } from "../../../src/utilities/escape.js"

// 2. Embedded HTMX URLs lose the db/auth segments:
-   hx-post="/api/db/auth/email/primary"
+   hx-post="/api/email/primary"
```

Everything between `onRequestGet` and the 405 catch-all is untouched.

## Blast radius

Measured 2026-06-09 by grep over `public/ functions/ src/ test/`:

- **~37** files reference `/api/db/auth/…`
- **~52** files reference `/api/db/…` (non-auth)

Plus, beyond the raw counts:

- **`wrangler.jsonc`** — `run_worker_first` list, and any path-scoped config.
- **`public/_headers` / CSP** — if any directive names these paths.
- **Tests** — URL assertions and path-based fixtures in `test/`.
- **Docs** — `docs/Architecture.md` and `.github/instructions/architecture.instructions.md`
  describe "routing by directory depth"; that becomes wrong, and the policy table becomes
  the thing to document.

## Execution plan

Staged so each stage is independently reviewable and the tree is never half-migrated in
a way that breaks routing. The ordering is governed by one constraint the naïve "add the
middleware, then move the files" reading misses.

### Sequencing: the new middleware is not inert

`functions/api/_middleware.ts` cascades to **every** descendant, including the
still-nested `functions/api/db/**` handlers that exist until their leaves move. So the
instant the composed middleware lands, a legacy request (`/api/db/auth/email/list`) runs
**both** chains: the new `[corsGate, maybeDb, maybeAuth, maybeOperator]` and *then* the
old `db/_middleware.ts` + `db/auth/_middleware.ts` beneath it. `policyFor` sends that
path to the fail-safe default `{ db: true, auth: true }`, so the Hyperdrive client opens
twice and session auth runs twice on every legacy route during the window. (An earlier
draft called this stage "inert" — it is not.)

The reverse order is worse: move handlers to flat paths *before* the new middleware
exists and they serve **unauthenticated** until it lands — a live hole, not just waste.

The fix is a **temporary passthrough** at the top of `policyFor`, so the new file defers
legacy paths to the old tree while both coexist:

```ts
// TEMP (deleted in the cleanup stage): the legacy nested tree still owns these.
if (pathname.startsWith("/api/db/")) return { db: false, auth: false, operator: false, cors: "internal" }
```

The only residue is `corsGate` re-running the same-origin check the old
`crossOriginWriteGuard` also runs — idempotent, harmless. With it in place each leaf
migrates independently: the moment a handler moves out of `/api/db/` it stops matching
the passthrough and the real policy applies. When the last subtree has moved, the
passthrough line and the four old middleware files are deleted in the same stage.

### Stages

1. **Extract the tier functions** (`cors.ts`, `session-auth.ts`, `operator-auth.ts` into
   `src/utilities/`, bodies lifted verbatim) and repoint the *existing* `_middleware.ts`
   files at them so they keep working unchanged. The DB-lifecycle dedup also lands here:
   `api/db/_middleware.ts` becomes `[sameOriginWriteGuard, createDbMiddleware("/api/db")]`,
   dropping its inline copy. The one net-new function, `externalCorsGuard`, ships with its
   own unit tests (preflight, allowlisted vs disallowed origin, no-Origin
   server-to-server). Pure no-behaviour-change refactor; `npm test` guards it alone.
2. **Compose + policy table + TEMP passthrough.** Add `functions/api/_middleware.ts`
   (above) importing the four tier functions, *with* the legacy-passthrough line. It now
   coexists with the old tree safely; `npm run typecheck` proves it compiles.
3. **Per-subtree flip.** For each subtree (`email/`, `user/`, `password/`,
   `organisations/`, `2fa/`, `passkeys/`, `admin/`, …): move its leaves to the flat path,
   fix each file's `../src/` import depth, rewrite that subtree's public URL references
   (`hx-get` / `hx-post` / `hx-vals`, `public/*.html`, handler HTML strings) **and** its
   tests — as **one commit per subtree**, each a working app. (This fuses the old steps 3
   and 5; splitting move from URL-rewrite breaks the app between commits.)
4. **Cleanup.** Once every subtree has moved: delete the now-dead
   `functions/api/db/_middleware.ts`, `…/db/auth/_middleware.ts`,
   `…/db/auth/admin/_middleware.ts`, `functions/api/billing/_middleware.ts`, **and** the
   TEMP passthrough line. The extracted tier functions in `src/utilities/` survive.
5. **Infra + docs.** Functional config (`wrangler.jsonc` `run_worker_first`, `_headers`/CSP
   if any directive names these paths) is flip-coupled — land it with the stage-3 commit
   that moves the relevant path. Prose (`docs/Architecture.md`,
   `.github/instructions/architecture.instructions.md`) is deferrable to the end.
6. **Gate.** `npm run lint && npm test`, plus the two net-new assertions: fail-safe
   default (an unlisted path is db+auth) and the CORS boundary (`/api/billing/*` external,
   a representative cookie endpoint internal).

> **Two gotchas the real tree surfaces.** (a) The org subtree carries **three
> resource-scoped middlewares** — `organisations/[org_uuid]/_middleware.ts`,
> `…/apps/[app_uuid]/_middleware.ts`, `…/teams/[team_uuid]/_middleware.ts` — that enforce
> per-resource membership/role authz. These are **not** tier middleware: they relocate
> **intact** with their subtree in stage 3 and must survive stage 4's deletion (which
> targets only the four named tier files). (b) Two source subtrees **merge** into one flat
> dir: the public `functions/api/db/organisations/invitation/view.ts` and the authed
> `functions/api/db/auth/organisations/**` both flatten to `functions/api/organisations/**`.
> Policy is per-path so they coexist, but the move must merge, not overwrite.

### Dependency graph

```
1  extract tiers ──────────────► old tree still green, independently testable
      │
2  add api/_middleware.ts + TEMP /api/db/ passthrough   (safe coexistence)
      │
3  per-subtree flip ─ email/ · user/ · password/ · organisations/ · 2fa/ · … ─┐
      │  each commit ships; functional infra rides along                       │ repeat
      └─────────────────────────────────────────────────────────────────────────┘
      │
4  delete 4 old _middleware.ts + remove TEMP passthrough   (only after ALL moved)
      │
5  docs ─ deferrable, may start any time after stage 1
      │
6  full gate: npm run lint && npm test
```

Hard edges: **1 → 2 → 3\* → 4 → 6.** What floats: the *new* tests (CORS boundary,
fail-safe) can be written right after stage 1; the **docs** half of stage 5 anytime; the
**functional** half of stage 5 is bound to the stage-3 commit that moves its paths.

### Models and effort

The cost concentrates in the design / security / test stages; the bulk file motion is
mechanical and best driven by scripts + grep verification rather than model reasoning.

| Stage | Character | Model | Effort | Why |
|-------|-----------|-------|--------|-----|
| 1 Extract + DB dedup + `externalCorsGuard` + tests | Net-new behaviour on a CSRF boundary | **Opus** | **High** | Not a pure lift: the dedup must preserve cors-guard ordering and the new guard is security-sensitive. Human review mandatory. |
| 2 Policy table + passthrough | Security-critical **enumeration** | **Opus** | **High** | Every `NO_DB` / `PUBLIC_DB` entry is a security decision; correctness needs the real endpoint inventory, not the sample lists. |
| 3 Move + import depth + URL rewrite | Mechanical, voluminous, miscount-prone | **Sonnet** | **Medium** | `git mv` + `../` recompute + two precise URL rewrites; verify each subtree's count to zero with grep. |
| 4 Delete + un-passthrough | Trivial, order-gated | **Haiku** | **Low** | Pure deletions; the only skill is not doing it before stage 3 finishes. |
| 5 Infra + docs | Config correctness + prose | **Sonnet** (config) / **Opus** (docs) | **Medium** | Wrong `run_worker_first`/CSP = silent breakage; the docs rewrite must explain the policy-table model. |
| 6 Tests + gate | New test design + iterative debug | **Opus** | **High → Medium** | Fail-safe and CORS-boundary assertions are judgment; chasing gate fallout across ~90 files needs capability. |

Throughout: cookie `Secure` / `SameSite` stay env-driven (never hardcoded); fixes are
**manual, not autoformatted**; diff with `--ignore-all-space` to keep CRLF churn out of
the change.

## Trade-offs and risks

- **New maintenance surface.** `NO_DB` / `PUBLIC_DB` is a second place that must stay in
  sync with the route files. Mitigated by the fail-safe default (a missed registration
  over-protects, never under-protects) — but it is a real cost the directory scheme did
  not have.
- **Loss of the "impossible to misplace" guarantee.** Today, an authed endpoint *cannot*
  be unauthed without moving its file out of the tree. After this change, auth is a table
  entry; correctness depends on the default being safe and on tests. Net security posture
  is *better* (safe default) but the guarantee is now runtime/config, not structural.
- **Wide diff.** ~90 files touched. Risk is mechanical error (a missed URL rename surfaces
  as a 404/405 in testing, not a silent security issue). Staging + the lint/test gate
  contains it.
- **A CORS guard now runs for the no-DB tier too.** Today `functions/api/*.ts` leaves
  (e.g. `/api/csp-report`) sit *above* the cross-origin guard and never see it; under this
  design every `/api/*` request passes through `corsGate` (element 0, ungated), which
  routes to the internal or external guard by policy. Confirm `/api/csp-report` (a `POST`
  from the browser, same-origin → internal guard) and any other no-DB POST still pass
  before shipping.
- **The internal/external split is a security boundary, not a convenience.** Marking a
  cookie-authed endpoint `external` strips its CSRF protection; marking a token-authed
  external endpoint `internal` breaks legitimate cross-origin callers (and re-introduces
  the header-less-passthrough reliance the split removes). The `corsModeFor` prefix
  (`/api/billing/`) and the fail-safe default (`internal`) keep the boundary explicit, but
  it is a line a reviewer must hold — worth a test asserting `/api/billing/*` is external
  and a representative cookie endpoint is internal.
- **The extraction is the safety net, not free.** Three middleware bodies move to
  `src/utilities/` before anything reroutes (step 1). Done as a verbatim lift with the old
  files still importing them, it is a behaviour-preserving refactor that `npm test` can
  guard on its own — so a bug in the *composition* (step 2+) can't be confused with a bug
  in a *tier*. The cost is one extra reviewable stage.

## Rejected alternatives

- **Per-endpoint wrappers** (`export const onRequestPost = withAuth(withDb(handler))`).
  Cleanest URLs and requirements visible per-file, but boilerplate in every handler and a
  weaker fail-safe (forget the wrapper → open endpoint). Option A keeps policy in one
  place and handlers boilerplate-free.
- **Rewrite layer** (pretty URL in front, `db/auth` tree behind). Not possible in Pages
  Functions — see [The constraint](#the-constraint).
- **Renaming the segments** to something less leaky. Does not satisfy the goal (the user
  wants the segments *absent*, not nicer).

## Out of scope

- `functions/` routes outside `/api/` (`oauth/`, `login/`, `.well-known/`,
  `organisations/`, top-level pages). They have their own `_middleware.ts` files and
  clean URLs already; this plan touches only the `/api/` tree.
- The root `functions/_middleware.ts` HTML auth-guard (Group A / Group B page gating).
  Unrelated to the API tiering and unchanged.
- `src/cron.ts` and the scheduled-cleanup path, which have no `_middleware.ts` by design.
