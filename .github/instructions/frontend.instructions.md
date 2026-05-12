---
applyTo: "public/**"
---

# Frontend Instructions

The frontend is static HTML served by the Cloudflare Worker via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) — the `public/` directory is the assets root. All interactivity is driven by HTMX; there is no custom client-side JavaScript.

## HTMX Conventions

### Response Handling

Every page that makes HTMX requests configures response handling in a meta tag to swap HTML for all expected status codes:

```html
<meta
  name="htmx-config"
  content='{"responseHandling": [
  {"code":"200", "swap": true},
  {"code":"400", "swap": true},
  {"code":"401", "swap": true},
  {"code":"403", "swap": true},
  {"code":"404", "swap": true},
  {"code":"405", "swap": true},
  {"code":"500", "swap": true}
]}'
/>
```

### Form Patterns

Forms use these HTMX attributes:

- `hx-post="/api/..."` or `hx-get="/api/..."` — the API endpoint.
- `hx-target="#result-id"` — where to swap the response HTML.
- `hx-validate="true"` — enable HTML5 validation before submission.
- `hx-disabled-elt=".btn-safe"` — disable the submit button during the request.
- `hx-include="[name='field1'], [name='field2']"` — explicitly include fields.

```html
<form
  hx-validate="true"
  hx-post="/api/db/user/login"
  hx-target="#login-result"
  hx-disabled-elt=".btn-safe"
>
  <div class="form-group">
    <label for="email">Email:</label>
    <input type="email" id="email" name="email" required />
  </div>
  <button type="submit" class="btn-safe">
    Log In <img class="htmx-indicator" src="/assets/bars.svg" />
  </button>
</form>
<div id="login-result" class="result-area"></div>
```

### Auto-Loading Sections

Sections that load content on page load and refresh on server-triggered events:

```html
<div
  id="email-list-container"
  hx-get="/api/db/auth/email/list"
  hx-trigger="load, emailListChanged from:body"
  hx-swap="innerHTML"
>
  <p>Loading email addresses...</p>
</div>
```

Key event names used with `HX-Trigger`: `emailListChanged`, `sessionListChanged`, `tfaStatusChanged`.

### Real-Time Validation

Password and email fields use delayed keyup triggers for live feedback:

```html
<input
  type="password"
  name="pw"
  hx-post="/api/password/requirements"
  hx-sync="closest form:abort"
  hx-trigger="keyup changed delay:500ms"
  hx-target="#password-requirements-output"
  minlength="12"
  maxlength="512"
/>
<div id="password-requirements-output" class="result-area"></div>
```

### Confirmations and Prompts

- `hx-confirm="Are you sure?"` — browser confirm dialog before submission.
- `hx-prompt="Enter value:"` — browser prompt dialog; value sent as `HX-Prompt` header.

## CSS Classes

### Buttons

- `.btn-safe` — Blue. Primary/safe actions (login, submit).
- `.btn-danger` — Red. Destructive actions (logout, terminate, remove).
- `.btn-save` — Green. Constructive actions (register, save).
- `.float-right` — Floats a button right with auto width.

### Results and Messages

- `.result-area` — Container for response messages. Padded, bordered, gray background. **Hidden when empty** via `.result-area:empty { display: none; }`.
- `.result-positive` — Dark green text for success messages.
- `.result-negative` — Dark red text for error messages.

### Layout

- `.container` — Centered card, max-width 500px.
- `.container.wide` — Wider variant, max-width 80rem (used for account dashboard).
- `.form-group` — Wraps a label + input pair with bottom margin.
- `.grid-container` — CSS Grid with auto-fit columns (min 200px).
- `.grid-container.grid-header` — Three-column grid for section headers: first column takes remaining space (left-aligned), subsequent columns auto-width (right-aligned).
- `.centered-link` / `.centered-link-secondary` — Centered navigation links below forms.

### HTMX Indicator

- `.htmx-indicator` — Hidden by default; shown as inline-block during `htmx-request`.
- Used with the `bars.svg` loading animation inside submit buttons.

### Utility Spacers

Single-property helpers used on `.result-area` containers and standalone controls. Prefer these over inline `style=""` attributes.

- `.spacer-bottom` — `margin-bottom: 1em`.
- `.spacer-top` — `margin-top: 1em`.
- `.spacer-top-small` — `margin-top: 0.5em`.

### 2FA Setup

Used by server-rendered HTML for the TOTP setup flow (`functions/api/db/auth/2fa/setup/start.js`):

- `.tfa-qr-layout` — Flex container holding the QR image + manual-entry secret side-by-side; wraps on narrow screens.
- `.tfa-qr-code` — Sizing constraint for the embedded QR image (`max-width: 200px; height: auto`).
- `.tfa-secret-display` — Monospace font with `word-break: break-all` for the displayed base32 secret.

## Page Structure

Every HTML page follows this structure:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="htmx-config" content='{"responseHandling": [...]}' />
    <title>Page Title</title>
    <link rel="stylesheet" href="/assets/main.css" />
    <script src="/assets/htmx_2.0.4.min.js"></script>
  </head>
  <body>
    <div class="container">
      <h1>Page Title</h1>
      <!-- Content -->
    </div>
  </body>
</html>
```

## Pages

| Page                 | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `index.html`         | Navigation index of all workflows                                    |
| `login.html`         | Email/password login form                                            |
| `register.html`      | Registration with live email-exists and password-requirements checks |
| `account.html`       | Dashboard: email management, sessions, password change, 2FA status   |
| `2fa.html`           | TOTP code entry during 2FA-gated login                               |
| `logout.html`        | Logout confirmation                                                  |
| `reset/request.html` | Password reset request (email input)                                 |
| `reset/set.html`     | Password reset completion (token + new password)                     |
