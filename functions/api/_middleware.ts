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
  "/api/csp-report",
  "/api/messages",
  "/api/password-requirements",
  "/api/providers",
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

export interface Policy {
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
  // ── TEMP (delete in the cleanup stage) ──────────────────────────────────
  // While the legacy nested tree still lives at /api/db/** and the legacy
  // billing middleware still lives at functions/api/billing/_middleware.ts,
  // defer those paths to the OLD middleware. Without this, this file would run
  // a SECOND DB connection + auth on top of the old chain for every legacy
  // request. billing passes through as "external" so corsGate runs the no-op
  // externalCorsGuard (not the same-origin block); /api/db passes through as
  // "internal" (the old db middleware also runs sameOriginWriteGuard — running
  // it twice is idempotent and harmless).
  if (pathname.startsWith("/api/db/")) return { db: false, auth: false, operator: false, cors: "internal" }
  if (pathname.startsWith("/api/billing/")) return { db: false, auth: false, operator: false, cors: "external" }
  // ── End TEMP ────────────────────────────────────────────────────────────

  // Real billing policy (active once the TEMP passthrough is removed): DB-only,
  // token/signature-authed in the handler, external CORS. PREFIX because
  // usage/[app_uuid] is dynamic.
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

// Exported for unit testing only. Pages ignores non-`onRequest` exports, so
// surfacing the policy resolver here is safe and keeps the table testable.
export { policyFor }
