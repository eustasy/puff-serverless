---
applyTo: "src/**,functions/**"
---

# Backend Code Conventions

## `src/` Module Conventions

Each `src/` module is a domain-scoped library of async functions. They contain no HTTP handling — that lives in `functions/api/`.

### Function Signatures

All `src/` functions accept `dbClient` as their first parameter:

```javascript
export async function readUser(dbClient, user_uuid) { ... }
export async function createSession(dbClient, user_uuid, user_agent, ip_address, ip_country) { ... }
export async function createToken(dbClient, user_uuid, token_type, expires_at, email_address) { ... }
```

### Return Value Conventions

Functions return structured objects — not raw query results. Two patterns are used:

**Success with data:**

```javascript
return { success: true, token_value: "..." }
return { success: true, email: result.rows[0] }
return { sessions: result.rows, status: 200 }
return { session_id: "...", status: 200, expires_at: date }
```

**Error objects:**

```javascript
return { error: true, message: "Descriptive message.", status: 400 }
return { error: true, message: "Server error.", details: error.message }
```

All `src/` functions return the envelope shape — none throw, none return raw rows or bare booleans. Predicates (`has2fa`, `password_verify`) expose their answer as a data field (`enabled`, `verified`) inside the success envelope.

`user_register` is the one exception that still throws (registration is a multi-step compound operation; throwing aborts the whole flow cleanly). Wrap calls to it in `try/catch`.

### Error Handling

- Wrap database calls in `try/catch`.
- Log errors with `console.error("Error in functionName:", error)`.
- Either return an error object or rethrow — don't swallow errors silently.

## `functions/api/` Endpoint Conventions

### HTTP Method Exports

Export named handlers for supported methods, plus a catch-all `onRequest` returning 405:

```javascript
export async function onRequestPost(context) {
  // Handler logic
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
```

Common method exports: `onRequestGet`, `onRequestPost`. The `Allow` header must list the actually supported methods.

### Accessing Context

```javascript
const dbClient = context.data.dbClient // From db middleware
const user_uuid = context.data.user_uuid // From auth middleware
```

### Extracting Input

**Form data (POST):**

```javascript
const formdata = await context.request.formData()
const email = formdata.get("email")
```

**Query parameters (GET):**

```javascript
const { searchParams } = new URL(context.request.url)
const token = searchParams.get("token")
```

**Request headers:**

```javascript
const userAgent = context.request.headers.get("User-Agent")
const ipAddress = context.request.headers.get("CF-Connecting-IP")
const ipCountry = context.request.headers.get("CF-IPCountry")
const cookieHeader = context.request.headers.get("Cookie")
const promptValue = context.request.headers.get("HX-Prompt") // From hx-prompt
```

### Validation Pattern

Validate all input at the top of the handler, before any database or business logic calls:

```javascript
export async function onRequestPost(context) {
  const formdata = await context.request.formData()
  const email = formdata.get("email")

  if (!email) {
    return new Response('<p class="result-negative">Email is required.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  // Proceed with business logic...
}
```

### Response Patterns

**Success (HTML fragment):**

```javascript
return new Response('<p class="result-positive">Operation succeeded.</p>', {
  headers: { "Content-Type": "text/html" },
})
```

**Success with event trigger:**

```javascript
return new Response('<p class="result-positive">Email added.</p>', {
  headers: {
    "Content-Type": "text/html",
    "HX-Trigger": "emailListChanged",
  },
})
```

**Redirect (HTMX-driven):**

```javascript
return new Response(null, {
  status: 303,
  headers: { "HX-Redirect": "/login?message=Registration successful." },
})
```

**Redirect (direct browser navigation):** Use a standard `Location` header — `HX-Redirect` is ignored outside HTMX. For endpoints that might receive either kind of caller (e.g., an email-link verification endpoint that could also be invoked via HTMX), branch on `HX-Request`:

```javascript
const target = "/login?code=email_verification_success"
const isHtmx = context.request.headers.get("HX-Request") === "true"
return new Response(null, {
  status: 303,
  headers: isHtmx ? { "HX-Redirect": target } : { Location: target },
})
```

See `functions/api/db/email/verify.js` for the canonical example.

**Error:**

```javascript
return new Response('<p class="result-negative">Invalid email address.</p>', {
  status: 400,
  headers: { "Content-Type": "text/html" },
})
```

**Error with retarget:**

```javascript
return new Response('<p class="result-negative">Server error.</p>', {
  status: 500,
  headers: {
    "Content-Type": "text/html",
    "HX-Retarget": "#message-area",
  },
})
```

### Session Cookie

Auth cookies are assembled from an options array, with `Secure` and `SameSite` driven by `context.env`. See `docs/ARCHITECTURE.md` for the env var defaults (`SECURE_COOKIE`, `COOKIE_SAMESITE`, `SESSION_MAX_AGE_SECONDS`).

Login endpoints set the session cookie:

```javascript
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
