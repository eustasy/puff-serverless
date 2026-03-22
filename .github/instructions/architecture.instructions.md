---
applyTo: "**"
---

# Architecture Instructions

This document provides instructions for the architecture of the project. It is intended to guide AI assistants in maintaining a consistent and scalable codebase.

## General Guidelines

- **Scalability**: Design components to be scalable to handle massively concurrent workloads.
- **Documentation**: Document all components with unclear interactions or intentions within the codebase.
- **Modularity**: Ensure that the code is modular and components are reusable.

## Structure

- The `functions/api` directory contains all code for dynamic content and API endpoints.
  - Endpoints are organized by functionality (e.g., `functions/api/db/auth`, `functions/api/user`).
  - Middleware files (e.g., `_middleware.js`) are used for request processing steps like database connection and authentication.
    - The `functions/api/db/_middleware.js` handles database client initialization via Cloudflare Hyperdrive and attaches it to `context.data.dbClient`. It also ensures the client is closed in a `finally` block after the request completes.
    - The `functions/api/db/auth/_middleware.js` handles session authentication by reading a `session_token` cookie and calling `verifyTokenAndGetUser`. On success it populates `context.data.user_uuid`.
  - Endpoints under `functions/api/db/` require database access (provided by db middleware).
  - Endpoints under `functions/api/db/auth/` additionally require authentication (provided by auth middleware).
  - Endpoints under `functions/api/` (but not `db/`) require neither database nor authentication (e.g., `password/requirements.js`).
- The `public` directory contains static content served by Cloudflare Pages. This includes:
  - HTML files (e.g., `index.html`, `login.html`, `account.html`, `2fa.html`, `logout.html`)
  - CSS files (`assets/main.css`)
  - Client-Side JavaScript (`assets/htmx_2.0.4.min.js` — the only client-side JS library)
  - Images (`assets/bars.svg` used as HTMX loading indicator)
  - Security headers (`_headers`) and redirect rules (`_redirects`)
  - Subdirectories for multi-page flows (`reset/request.html`, `reset/set.html`)
- The `src` directory contains all backend logic, organized by domain.
  - `src/users.js` — user registration, login orchestration, soft-delete, last-login tracking.
  - `src/sessions.js` — session creation, verification, listing, and termination.
  - `src/passwords.js` — password hashing, verification, requirements checking, and HaveIBeenPwned integration.
  - `src/emails.js` — email CRUD, verification by token, and primary email management.
  - `src/tokens.js` — generic token CRUD plus typed helpers for email verification, password reset, login (2FA step-up), and sudo elevation tokens.
  - `src/2fa.js` — TOTP secret CRUD, enable/disable, and usage tracking.
  - The `src/utilities` directory contains helper functions:
    - `src/utilities/hashing.js` — SHA-384 password hashing with salt, SHA-1 for HaveIBeenPwned k-anonymity.
    - `src/utilities/headers.js` — cookie parsing (`getCookie`) and user-agent parsing (`parseUserAgent`).
- The `sql` directory contains CockroachDB schema definitions (one file per table).
  - `users.sql` must be imported first as it provides the foreign key for other tables.
  - Tables: `users`, `sessions`, `emails`, `secrets` (passwords + TOTP), `tokens` (verification, reset, 2FA step-up).

## API Design

- The API is primarily consumed by HTMX from static HTML pages.
- API endpoints should return HTML fragments designed for HTMX swapping — not JSON.
- Avoid returning JSON unless explicitly requested or for error responses that cannot be handled with HTML.
- Utilize HTMX response headers:
  - `HX-Redirect` for client-side navigation: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/login?message=Success." } });`
  - `HX-Trigger` to fire client-side events that refresh other page sections (e.g., `"emailListChanged"`, `"sessionListChanged"`, `"tfaStatusChanged"`).
  - `HX-Retarget` to redirect an error response to a different DOM target than the form's default.
- The API should be stateless; each request must contain all necessary information.
- Use appropriate HTTP status codes (200, 303, 400, 401, 403, 404, 405, 500).
- Reference table schemas in `sql/*.sql` files when designing database interactions.

## General Instructions

These instructions are to avoid unwanted AI activity:

- Do not add small comments for simple code changes (e.g., `// Import the new function`).
- Do not add comments that are obvious from the code itself.
- Do not return JSON from API endpoints unless explicitly requested.
- Do not check for conditions already handled by preceding middleware (e.g., database connectivity, authentication).
- **Input Validation**: Perform input validation (e.g., form data, query parameters) at the beginning of API endpoint handlers, before any database calls.
- **Database Connectivity**:
  - Access the database client via `const dbClient = context.data.dbClient` in API handlers, relying on `functions/api/db/_middleware.js` to provide it.
  - Do not create new database connections in API handlers or `src` functions.
- **Authentication**:
  - Access the authenticated user via `const user_uuid = context.data.user_uuid` in API handlers, relying on `functions/api/db/auth/_middleware.js` to provide it.
  - Do not re-authenticate in API handlers or `src` functions.
- **Response Handling**:
  - **Success**: `return new Response('<p class="result-positive">Success!</p>', { headers: { "Content-Type": "text/html" } });`
  - **Redirects**: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/target" } });`
  - **Errors**: `return new Response('<p class="result-negative">Error message.</p>', { status: 400, headers: { "Content-Type": "text/html" } });`
  - **Refresh triggers**: Include `"HX-Trigger": "eventName"` header to refresh related page sections.
- **Function Naming**: Cloudflare Pages functions export `onRequestGet`, `onRequestPost`, etc. for specific methods. Export a catch-all `onRequest` that returns 405 with an `Allow` header for unsupported methods.
- **Middleware Chaining**: Database middleware runs before auth middleware. Auth middleware depends on `context.data.dbClient` being populated.
