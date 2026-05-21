---
applyTo: "src/**,functions/**"
---

# Backend Code Conventions

## `src/` Module Conventions

Each `src/` module is a domain-scoped library of async functions. They contain no HTTP handling — that lives in `functions/api/`.

### Function Signatures

All `src/` functions accept `dbClient: DbClient` as their first parameter:

```ts
export async function readUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ user: UserRow }>> { ... }

export async function createSession(
  dbClient: DbClient,
  user_uuid: string,
  user_agent: string,
  ip_address: string,
  ip_country: string
): Promise<...>

export async function createToken(
  dbClient: DbClient,
  user_uuid: string,
  token_type: string,
  expires_at: Date,
  email_address?: string
): Promise<...>
```

`DbClient` is the ambient global alias for `pg.Client` (see `types.d.ts`). `Envelope<T>` is the canonical envelope union, also ambient.

### Return Value Conventions

The canonical envelope is a three-variant discriminated union (`types.d.ts`):

```ts
type Envelope<T = {}> =
  | ({ success: true; error?: never; status: number } & T) // ran successfully
  | { success: false; error?: never; message: string; status: number } // validation / business-rule failure
  | {
      success?: never
      error: true
      message: string
      details?: unknown
      status: number
    } // DB / system error
```

Narrow with `if (result.error)` / `if (result.success)` / `if (!result.success)`. Examples:

```ts
return { success: true, token_value: "...", status: 201 }
return { success: true, email: row, status: 200 }
return { success: true, sessions: result.rows, status: 200 }

return { success: false, message: "User not found.", status: 404 }

return {
  error: true,
  message: "Server error.",
  details: err,
  status: 500,
}
```

All `src/` functions return the envelope shape — none throw, none return raw rows or bare booleans. Predicates (`has2fa`, `verifyPassword`) expose their answer as a data field inside the success envelope (`enabled`, `verified`).

`registerUser` is the one exception that still throws — registration is a multi-step compound operation; throwing aborts the whole flow cleanly. Wrap calls in `try/catch`.

`src/tokens.ts` uses a slightly older `TokenEnvelope` variant (no `status` field). Aligning it with `Envelope` is a tracked follow-up; keep that shape when extending `tokens.ts` until then.

### Error Handling

- Wrap database calls in `try/catch`.
- Log errors with `console.error("Error in functionName:", error)`. Never log secrets or PII payloads.
- Either return an error envelope or rethrow — don't swallow errors silently.

### Transactions

Multi-step writes that must be atomic use `runInTransaction` from `src/utilities/transaction.ts` — never hand-rolled `BEGIN`/`COMMIT`/`ROLLBACK`. See `database.instructions.md → Transactions` for the full pattern (SERIALIZABLE retry handling is built in).

## `functions/api/` Endpoint Conventions

### HTTP Method Exports

Export named handlers for supported methods, plus a catch-all `onRequest` returning 405:

```ts
export const onRequestPost: Handler = async (context) => {
  // Handler logic
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
```

`Handler<P>` is the ambient alias for `PagesFunction<Env, P, RequestData>`. `methodNotAllowed(...)` is from `src/utilities/responses.ts` and emits the 405 + `Allow` header. The `Allow` header must list the actually supported methods.

Common method exports: `onRequestGet`, `onRequestPost`. Catch-all goes through `onRequest`.

### Accessing Context

```ts
const dbClient = context.data.dbClient! // From db middleware
const user_uuid = context.data.user_uuid! // From auth middleware (under db/auth/)
const orgRoles = context.data.orgRoles ?? [] // Under organisations/[org_uuid]/
const teamRoles = context.data.teamRoles ?? [] // Under teams/[team_uuid]/
const app = context.data.app! // Under apps/[app_uuid]/
```

### Extracting Input

**Form data (POST):**

```ts
const formdata = await context.request.formData()
const email = formdata.get("email")
if (typeof email !== "string" || !email) {
  return resultNegative("Email is required.", 400)
}
```

**Query parameters (GET):**

```ts
const { searchParams } = new URL(context.request.url)
const token = searchParams.get("token")
```

**Request headers:**

```ts
const userAgent = context.request.headers.get("User-Agent")
const ipAddress = context.request.headers.get("CF-Connecting-IP")
const ipCountry = context.request.headers.get("CF-IPCountry")
const cookieHeader = context.request.headers.get("Cookie")
const promptValue = context.request.headers.get("HX-Prompt") // From hx-prompt
```

### Authorisation

For endpoints under `functions/api/db/auth/organisations/[org_uuid]/...`, authorise via the typed capability matrix in `src/permissions.ts`:

```ts
import { can } from "../../../../../src/permissions.js"

const orgRoles = context.data.orgRoles ?? []
if (!can(orgRoles, "org:members:invite")) {
  return resultNegative("You do not have permission to do this.", 403)
}
```

Team endpoints typically allow either the team role or the org-level override:

```ts
if (!can(teamRoles, "team:update") && !can(orgRoles, "org:teams:manage")) {
  return resultNegative("You do not have permission to do this.", 403)
}
```

Never authorise on raw role strings.

### Validation Pattern

Validate all input at the top of the handler, before any database or business logic calls:

```ts
export const onRequestPost: Handler = async (context) => {
  const formdata = await context.request.formData()
  const email = formdata.get("email")

  if (typeof email !== "string" || !email) {
    return resultNegative("Email is required.", 400)
  }

  // Proceed with business logic...
}
```

### Response Patterns

**Success (HTML fragment):**

```ts
return resultPositive("Operation succeeded.", 200)
// or, when you need to fine-tune headers:
return new Response('<p class="result-positive">Operation succeeded.</p>', {
  headers: { "Content-Type": "text/html" },
})
```

**Success with event trigger:**

```ts
return resultPositive("Email added.", 200, { "HX-Trigger": "emailListChanged" })
```

**Redirect (HTMX-driven):**

```ts
return new Response(null, {
  status: 303,
  headers: { "HX-Redirect": "/login?message=Registration successful." },
})
```

**Redirect (direct browser navigation):** use a standard `Location` header — `HX-Redirect` is ignored outside HTMX. For endpoints that might receive either kind of caller (e.g., an email-link verification endpoint that could also be invoked via HTMX), branch on `HX-Request`:

```ts
const target = "/login?code=email_verification_success"
const isHtmx = context.request.headers.get("HX-Request") === "true"
return new Response(null, {
  status: 303,
  headers: isHtmx ? { "HX-Redirect": target } : { Location: target },
})
```

See `functions/api/db/email/verify.ts` for the canonical example.

**Error:**

```ts
return resultNegative("Invalid email address.", 400)
```

**Error with retarget:**

```ts
return new Response('<p class="result-negative">Server error.</p>', {
  status: 500,
  headers: {
    "Content-Type": "text/html",
    "HX-Retarget": "#message-area",
  },
})
```

### Audit emit

Account and organisation mutations emit a structured event via `emitFromContext` after the mutation succeeds:

```ts
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"

// ...mutation succeeded...
await emitFromContext(context, {
  event_type: EVENTS.ACCOUNT_PASSWORD_CHANGED,
  target_user_uuid: user_uuid,
})
```

Event type strings are constants in `src/hooks/events.ts` — never bare strings. Default severity is looked up from `DEFAULT_SEVERITY` in the same file; override only when context warrants escalation. See `docs/Operations.md → Audit events & hooks`.

### External API calls

Outbound `fetch()` from the Worker has two patterns depending on whether the response shapes the user-facing reply.

**Cacheable lookups** — pass `cf.cacheTtl` so Cloudflare's per-colo HTTP cache memoises the response. Cache key is the URL; pick a TTL based on how fresh the data needs to be:

```ts
const response = await fetch(externalUrl, {
  cf: { cacheTtl: 86400, cacheEverything: true },
})
```

Canonical example: `hibpBreachCount` in `src/passwords.ts` (24h TTL — the HIBP k-anonymity dataset only changes when new breaches are processed).

**Fire-and-forget calls whose result doesn't affect the response** — use `context.waitUntil` so the response is sent immediately and the call continues in the background. The Worker isolate stays alive until the promise settles; without `waitUntil` the runtime may kill the isolate the moment the response is committed:

```ts
context.waitUntil(
  sendVerificationEmail(context.env, email, token).then((mailResult) => {
    if (mailResult.error) {
      console.error("Failed to send verification email:", mailResult.message)
    }
  })
)

return resultPositive("Done.", 200)
```

Canonical examples: password-reset email (`functions/api/db/password/request.ts`), 2FA-bypass email (`functions/api/db/2fa/bypass/request.ts`), federated-signup verify email (`functions/api/db/federated-signup/confirm.ts`). All three intentionally stay generic regardless of delivery outcome (enumeration prevention / best-effort delivery), so `waitUntil` is the right primitive.

**Synchronous external calls whose result shapes the response** — keep `await`. Examples: OAuth-provider userinfo fetch on the federated-login callback (must complete before issuing the session), invitation email on `organisations/[org_uuid]/members/invite.ts` (handler returns 502 on delivery failure so the operator knows), `email/resend.ts` (user explicitly asked, so failure is surfaced inline).

**Don't use queues.** Cloudflare Queues are for async work delivery, not caching or fire-and-forget. For Puff's volume `waitUntil` + `cf.cacheTtl` cover every current case. Re-evaluate only if a real volume / rate-limit / retry requirement emerges.

### Session Cookie

Auth cookies are assembled from an options array, with `Secure` and `SameSite` driven by `context.env`. See `docs/Architecture.md` for the env var defaults (`SECURE_COOKIE`, `COOKIE_SAMESITE`, `SESSION_MAX_AGE_SECONDS`).

Login endpoints set the session cookie:

```ts
const cookieOptions = [
  `session_token=${session_id};`,
  "Path=/",
  "HttpOnly",
  `Expires=${new Date(expires_at).toUTCString()}`,
  `SameSite=${context.env.COOKIE_SAMESITE || "Lax"}`,
]
if (context.env.SECURE_COOKIE) {
  cookieOptions.push("Secure")
}
headers["Set-Cookie"] = cookieOptions.join("; ")
```

Logout endpoints clear it with the same pattern, substituting an expired `Expires` or `Max-Age=0`. Never hardcode `Secure` or `SameSite=Strict` — that bypasses the env-var configuration.

The login-flow plumbing (decide between session vs. 2FA step-up vs. password-upgrade) is encapsulated in `loginOutcomeResponse` from `src/utilities/login-response.ts`. Reuse it for any endpoint that completes a login.
