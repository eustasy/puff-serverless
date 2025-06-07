---
applyTo: "**"
---

# Architecture Instructions

This document provides instructions for the architecture of the project. It is intended to guide ai assistants in maintaining a consistent and scalable codebase.

## General Guidelines

- **Scalability**: Design components to be scalable to handle massively concurrent workloads.
- **Documentation**: Document all components with unclear interactions or intentions within the codebase.
- **Modularity**: Ensure that the code is modular and components are reusable.

## Structure

- The `functions/api` directory contains all code for dynamic content and API endpoints.
  - Endpoints are organized by functionality (e.g., `functions/api/db/auth`, `functions/api/user`).
  - Middleware files (e.g., `_middleware.js`) are used for request processing steps like database connection and authentication.
    - The `functions/api/db/_middleware.js` typically handles database client initialization and attaches it to `context.data.dbClient`.
    - The `functions/api/db/auth/_middleware.js` handles session authentication using `sessionAuthWithCookie` and populates `context.data.user_uuid`.
- The `public` directory contains static content. This includes:
  - HTML files (e.g., `index.html`, `login.html`, `account.html`)
  - CSS files (e.g., `assets/main.css`)
  - Client-Side JavaScript files (e.g., `assets/htmx_2.0.4.min.js`)
  - Images (e.g., `assets/bars.svg`)
- The `src` directory contains all backend logic, organized by domain.
  - Examples: `src/users.js`, `src/sessions.js`, `src/2fa.js`, `src/emails.js`, `src/passwords.js`, `src/tokens.js`.
  - The `src/utilities` directory contains helper functions.
    - `src/utilities/hashing.js` for password hashing and verification.
    - `src/utilities/headers.js` for cookie parsing and user-agent parsing.
- The `sql` directory contains database schema definitions (e.g., `users.sql`, `sessions.sql`).

## API Design

- The API is primarily fetched with HTMX.
- API endpoints should generally return HTML fragments designed for HTMX swapping (e.g., `hx-swap`, `hx-target`).
- Avoid returning JSON unless absolutely necessary or explicitly requested.
- API responses can be full HTML pages if designed to be inserted into the current page context.
- Utilize HTMX response headers like `HX-Redirect` for client-side navigation.
  - Example: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/login?message=Logout successful." } });`
- The API should be stateless; each request must contain all necessary information.
- Use appropriate HTTP status codes (e.g., 200, 303, 400, 401, 403, 404, 405, 500).
- Ensure API security: validate inputs, protect against common web vulnerabilities.
- Reference table schemas in `sql/*.sql` files when designing database interactions.
- For HTMX details, see [HTMX Documentation](https://htmx.org/docs/) and [HTMX References](https://htmx.org/reference/).

## General Instructions

These instructions are to avoid unwanted ai activity:

- Do not add small comments for simple code changes (e.g., `// Import the new function`).
- Do not add comments that are obvious from the code itself.
- Do not return JSON from API endpoints unless explicitly requested or it's an error response that cannot be gracefully handled with HTML for HTMX.
- Do not check for conditions already handled by preceding middleware or utility functions (e.g., database connectivity in API handlers if middleware handles it).
- **Input Validation**: Perform input validation (e.g., form data, query parameters) at the beginning of API endpoint handlers.
- **Database Connectivity**:
  - Database client initialization (e.g., `const dbClient = context.data.dbClient;`) should occur in API handlers that need database access, relying on middleware (like `functions/api/db/_middleware.js`) to populate `context.data.dbClient`.
  - Do not establish new database connections directly within individual API endpoint handlers or `src` functions if middleware provides a client.
- **Authentication**:
  - Authentication initialization (e.g., `const user_uuid = context.data.user_uuid;`) should occur in API handlers that need user information, relying on middleware (like `functions/api/db/auth/_middleware.js`) to populate `context.data.user_uuid`.
  - Do not attempt to re-authenticate directly within individual API endpoint handlers or `src` functions if middleware provides a user UUID or session.
- **Response Handling**:
  - **HTMX Responses**: Return HTML fragments or full pages that can be swapped into the current page context.
    - Example: `return new Response('<div class="result-positive">Success!</div>', { headers: { "Content-Type": "text/html" } });`
  - **Redirects**: Use `HX-Redirect` for client-side navigation.
    - Example: `return new Response(null, { status: 303, headers: { "HX-Redirect": "/dashboard" } });`
  - **Error Handling**: Return HTML error messages suitable for HTMX display, including appropriate `HX-Retarget` if needed.
  - Example: `return new Response('<p class="result-negative">Error: Something went wrong.</p>', { status: 400, headers: { "Content-Type": "text/html", "HX-Retarget": "#message-area" } });`
- **Function Naming**: Cloudflare Pages functions often use `onRequest`, `onRequestGet`, `onRequestPost`, etc.
- **Middleware Chaining**: Be aware of the order of middleware execution. For instance, database connection middleware must run before authentication middleware that relies on a database.
