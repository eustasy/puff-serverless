# Phase 11 — UI

A redesign brief, not a recreation checklist. The current pages grew up as development harnesses — `index.html` is a workflow index, `account.html` exposes "Refresh" buttons, the password-reset token is an editable text field — and the styling is leftover Bootstrap-4-ish colours with almost no accessibility affordances. This phase rethinks each surface around its **job**, with two non-negotiable goals: **maximum accessibility** (WCAG 2.2 AA as the floor) and **minimum friction** (count the interactions on every happy path). This document is a **planning document only** — it audits the current UI, fixes the information architecture, and writes the per-surface briefs and design-system requirements that a later design/execution pass (Claude Design) will implement. No code is touched here.

## Table of Contents

- [How to use this document](#how-to-use-this-document)
- [Goals](#goals)
- [Fixed constraints](#fixed-constraints)
- [Current-state inventory](#current-state-inventory)
- [UX audit — friction findings](#ux-audit--friction-findings)
- [Accessibility audit — findings](#accessibility-audit--findings)
- [Target information architecture](#target-information-architecture)
- [Per-surface briefs](#per-surface-briefs)
- [Design-system requirements](#design-system-requirements)
- [Accessibility requirements (normative)](#accessibility-requirements-normative)
- [The fragment class contract](#the-fragment-class-contract)
- [Staging (future execution phase)](#staging-future-execution-phase)
- [Verification](#verification)
- [Open questions / decisions for the design phase](#open-questions--decisions-for-the-design-phase)
- [Out of scope](#out-of-scope)

## How to use this document

The audience is the design/execution agent. Findings are numbered (`F#` friction, `A#` accessibility) so the per-surface briefs and stages can reference them. "MUST" items are acceptance criteria; "SHOULD" items are strong defaults the designer may overrule with a written reason in this file. Deliverables of the execution phase:

1. A rewritten `public/assets/main.css` (design tokens + components).
2. Rewritten static pages under `public/`.
3. Updated markup in the server-rendered shells and HTML fragments (`functions/**.ts`, `src/utilities/`), kept in lockstep with the CSS per [the fragment class contract](#the-fragment-class-contract).
4. The [Verification](#verification) checklists, completed.

## Goals

- **Good UX over parity.** Redesign each surface around what the user is trying to do; do not transcribe the existing pages into new CSS.
- **WCAG 2.2 AA** on every page and fragment, including the server-rendered ones.
- **Minimum friction**: fewest fields, fewest clicks, no exposed machinery, no dead ends. Every flow's happy path is counted in interactions and justified.
- **Coherence**: one design system, one voice, one navigation model across static pages, server-rendered shells, and HTMX fragments.

## Fixed constraints

These are decisions, not open questions:

- [x] **UI lives in `public/`**: HTML, CSS, and minimal **vanilla** client-side JS. No frameworks, no build step, no preprocessor. `webauthn.js` stays as the model for what client JS should look like (self-contained module, loaded only where needed).
- [x] **Dynamic content stays HTMX**: API endpoints return HTML fragments, not JSON. The HTMX 4 conventions in `.github/instructions/frontend.instructions.md` (explicit attribute sets, no implicit inheritance, `hx-disable`, `HX-Trigger` refresh events) carry over unchanged.
- [x] **No key-value UI.** The "Stored Data" section on `account.html` is removed, not redesigned. The `/api/keyvalues/*` endpoints remain (programmatic/API surface) — only the page section goes.
- [x] **Account settings and Organisation settings are separate surfaces.** `/account` is personal (identity, security, sessions); `/organisations/:org_uuid` is the org's home. The account page links to organisations; it does not embed their management.
- [x] **Billing is managed per-organisation**, at `/organisations/:org_uuid/billing`. No account-level billing surface.
- [x] **CSP-safe**: no inline event handlers, no `eval`-adjacent patterns. Small inline `<script>` blocks of the existing style (DOM-only, CSP-safe) are acceptable; anything bigger becomes a module in `public/assets/`.
- [x] **Reflected user input goes through `escapeHtml`** (`src/utilities/escape.ts`) — unchanged.
- [x] **English only** (`lang="en"`); i18n is out of scope.

## Current-state inventory

Static pages (`public/`): `index.html` (workflow index), `login.html`, `register.html`, `account.html` (dashboard: emails, password, 2FA, passkeys, linked accounts, sessions, stored data, organisations), `2fa.html`, `password-upgrade.html`, `logout.html`, `reset/request.html`, `reset/set.html`.

Server-rendered shells (`functions/`): `/organisations/:org_uuid` (panel shell → `read` fragment: details, lifecycle, teams, members, invitations), `/organisations/:org_uuid/billing` (subscriptions, payment-method portal, invoices), `/invite?token=…`, `/federated-signup?token=…`, and the **OAuth consent screen** built by `src/utilities/oauth-authorize.ts` (`buildConsentPage` / the error page).

Fragments: ~50 `.ts` files under `functions/api/` (plus helpers in `src/utilities/`) emit classed HTML — lists (emails, sessions, passkeys, external identities, organisations, teams, members, invitations, billing), status panels (2FA), result messages, and the providers button row.

Styling: one stylesheet, `public/assets/main.css` — Bootstrap-4-era palette (`#007bff`/`#28a745`/`#dc3545`), centered 500px card (`.container`), 80rem dashboard (`.container.wide`), auto-fit grid, table styles, result areas, HTMX indicator (`bars.svg`).

## UX audit — friction findings

- **F1 — `index.html` is a developer index, not a landing page.** An `<h3>`-headed nested list of workflows, half of them not links. The root URL should route: signed-in → `/account`, signed-out → `/login`. The root `functions/_middleware.ts` already does presence-only cookie redirects for page groups, so this can be a server-side redirect rather than a JS sniff.
- **F2 — Logout is a destination, not an action.** Today: navigate to `/logout`, then click a button. Logout should be a header action (`hx-post` + `hx-confirm`) available on every signed-in page; `/logout` survives only as the post-logout confirmation/fallback page.
- **F3 — `account.html` is a monolith with no orientation.** No identity context ("signed in as …"), no in-page navigation, a bare "Log Out" link buried between Linked accounts and Sessions, and section order that buries security controls. Needs grouping and an explicit order (see brief).
- **F4 — Manual "Refresh" buttons expose machinery.** Emails, Sessions, Stored Data, and Organisations all carry refresh buttons, but every mutation already refreshes its list via `HX-Trigger` events. Remove the buttons.
- **F5 — The reset token is an editable text field** on `reset/set.html`, populated from the URL by inline script. When the token is in the URL it should be a hidden input; show a visible field only as the no-token fallback.
- **F6 — The 2FA challenge has mid-flow distractions and mobile friction.** A "Don't have an account? Register" link in the middle of a login, and the OTP input lacks `inputmode="numeric"` (no numeric keypad on mobile). The single-purpose page should autofocus the code field.
- **F7 — Passkey sign-in reads as a separate, second-class flow.** "Sign in with a passkey for the email above" + a button below an `<hr>`. The email field already has `autocomplete="email webauthn"` (conditional UI); the page should present one sign-in surface with passkey, password, and providers as peer methods.
- **F8 — Feedback lands far from the action.** Add-email errors render in `#email-message-area` above the list while the form sits in the section header; password-change messages render above the form. Co-locate each result area with its control.
- **F9 — Undefined classes render as plain text.** `functions/api/email/list.ts` emits `badge bg-primary`/`bg-success`/`bg-warning` (Bootstrap leftovers — no CSS exists), and the pages use `form-input`, also undefined. Define real `.badge` variants; delete or define `form-input`.
- **F10 — The OAuth consent screen is completely unstyled.** `buildConsentPage` emits no stylesheet and no viewport meta. For an SSO product this is the page third-party users see most; it must join the design system (link `/assets/main.css` — same origin) and get the consent-screen brief below.
- **F11 — The organisation page lacks hierarchy and guardrails.** Generic `<h1>Organisation</h1>` with the org name in an `<h3>` (skipping `h2`); raw role strings (`owner`, `billing`…) in `<select>`s with no explanation; Disable/Delete sitting inline next to Save. Org name belongs in the `h1`; roles need one-line descriptions; lifecycle actions belong in a separated danger zone.
- **F12 — Confirmation and message conventions are inconsistent.** `hx-confirm` native dialogs are fine (accessible, zero JS) and stay, but wording must name the object being acted on ("Remove `bob@example.com`?" not "Are you sure?"). Result areas mix roles — some targets receive lists, others messages; transient successes persist forever. Standardise: lists swap into list containers, messages into live-region message areas (see A1).
- **F13 — Page titles don't orient.** `reset/request` and `reset/set` share the title "Reset Password"; the 2FA page is "Login - 2 Factor Authentication". Titles must be unique and front-loaded (WCAG 2.4.2).

## Accessibility audit — findings

The current frontend contains **one** ARIA attribute in total (an `aria-describedby` on the account page's password field). Concretely:

- **A1 — HTMX swaps are silent to assistive technology.** Result messages (login errors, success confirmations) swap into plain `<div>`s. Fix: every message-area `.result-area` is a **pre-existing live region** — `role="status"` (polite) as the default, with error fragments announced via a `role="alert"` element *inside* the swapped fragment where immediate announcement matters. Because the target `div`s already exist in the DOM before the swap, `innerHTML` swaps into them announce correctly. The single place to standardise message markup is `src/utilities/responses.ts` (`resultPositive`/`resultNegative` helpers) plus the handful of endpoints that hand-roll message HTML.
- **A2 — No landmarks on most pages.** Only `account.html` and the org shells have `<header>`/`<main>`; everything else is a bare `div.container`. Every page gets `<main>`, a `<header>` where there is a shell, and `<nav>` where navigation exists.
- **A3 — No skip link.** Required once the shared header lands (WCAG 2.4.1).
- **A4 — State is conveyed by colour alone** (WCAG 1.4.1). `.result-positive`/`.result-negative` differ only in green vs red text. Add a non-colour signal — an icon or a visible "Success:"/"Error:" prefix — emitted by the response helpers so all ~50 fragment files inherit it.
- **A5 — Button contrast fails AA** (WCAG 1.4.3). White text on `#28a745` ≈ 3.1:1 and on `#007bff` ≈ 4.0:1 (both fail 4.5:1); `#dc3545` ≈ 4.5:1 (borderline). The token palette must use AA-passing pairs, and meet 1.4.11 (3:1 non-text) for input borders and focus rings.
- **A6 — No visible focus styling.** Browser default only. Design a `:focus-visible` ring as a token (offset + colour) applied to every interactive element (WCAG 2.4.7, 2.4.13 awareness).
- **A7 — Motion ignores user preference.** The `bars.svg` loading indicator animates unconditionally; SMIL inside an `<img>` cannot be paused by page CSS. Replace with a CSS-animated indicator element wrapped in `@media (prefers-reduced-motion: no-preference)`, with a static/text fallback otherwise.
- **A8 — Loading and busy states are unannounced.** Keep the "Loading…" placeholder text pattern for initial loads (it is honest and simple); add `aria-busy="true"` styling hooks via HTMX's `htmx-request` class. Do **not** announce routine list refreshes — only user-initiated outcomes (A1).
- **A9 — Tables lack captions and header scope.** List tables (emails, sessions, members…) get `<caption>` (visually hidden is fine) and `scope="col"`.
- **A10 — Action buttons don't name their object.** A row's "Remove" button must be accessible as "Remove `bob@example.com`" (visible text or `aria-label` composed in the fragment). Also satisfies F12's confirm wording.
- **A11 — Small targets.** Row-action buttons must meet the 24×24 CSS px minimum (WCAG 2.5.8); the design system sets button min-height globally.
- **A12 — Indicator images are inconsistently hidden.** Most carry `alt=""`; the billing shell's omits `alt` entirely. The replacement indicator (A7) must be `aria-hidden="true"` and decorative by construction.
- **A13 — Form hints aren't programmatically associated.** Password-requirements panels and inline hints need `aria-describedby` from the input (today only one site has it). Placeholders are never the only label (labels already exist everywhere — keep that).
- **A14 — Autofocus discipline.** Autofocus only on true single-purpose pages (2FA code, reset/set password when token is hidden). Never autofocus on pages with content above the form.

## Target information architecture

```text
Signed out
  /                  → redirect to /login (or /account when a session cookie is present)
  /login             one sign-in surface: password + passkey + federated providers
  /register          create account
  /reset/request     request reset link
  /reset/set         set new password (token from URL)
  /2fa               TOTP challenge mid-login (+ bypass)
  /password-upgrade  forced password upgrade mid-login
  /invite            invitation preview/accept
  /federated-signup  confirm account creation from a federated identity
  /oauth/authorize   consent screen (third-party app authorisation)

Signed in
  /account                          Account Settings (personal)
  /organisations/:org_uuid          Organisation Settings (per-org)
  /organisations/:org_uuid/billing  Organisation Billing (per-org)
  /logout                           post-logout confirmation / fallback
```

**Shared shell.** Signed-in pages (`/account`, org pages) share a slim header: product name (links to `/account`), and a Log Out button (`hx-post="/api/user/logout"` + `hx-confirm`). A skip link precedes it. Signed-out pages keep the centered-card layout with no header chrome. Showing "signed in as `<email>`" in the header requires a small identity fragment endpoint that does not exist today — see [Open questions](#open-questions--decisions-for-the-design-phase).

**Account ⇄ organisation boundary.** `/account`'s Organisations section is a *directory*: each org the user belongs to, their roles, a "Create organisation" control, and links out to each org's page. All management (rename, teams, members, invitations, entitlements, lifecycle, billing) lives on the org's own pages.

## Per-surface briefs

Each brief: the job, what changes, and the findings it must resolve.

### Root (`/`)

Job: get the visitor to the right place. Server-side redirect via the root middleware (F1). `index.html`'s workflow list is deleted — if a human-readable index is wanted for development, it moves to `docs/`.

### Login (`/login`)

Job: sign in, in one screen, by any supported method. One card presenting the methods as peers (F7): email + password with submit; a passkey button (conditional-UI autofill already wired via `autocomplete="email webauthn"`); federated provider buttons (HTMX-loaded from `/api/providers`). The `/api/messages` banner (post-redirect notices) renders at the top in a live region (A1). Links: register, reset — as quiet footer links, not competing actions. Resolves F7, A1, A2; title per F13.

### Register (`/register`)

Job: create an account with confidence the password will be accepted. Keep the live email-exists and password-requirements checks (genuinely good UX — they prevent dead-end submits). The requirements panel becomes a checklist associated to the field via `aria-describedby` (A13), updating politely, with non-colour pass/fail markers (A4). No "confirm password" field (modern practice; `autocomplete="new-password"` + visibility toggle is the safety net — toggle is an Open question).

### 2FA challenge (`/2fa`)

Job: enter the code and finish signing in. Single-purpose: code field (`inputmode="numeric"`, `autocomplete="one-time-code"`, autofocused — A14), submit, and the bypass `<details>` (keep — good pattern). Remove the register link (F6). Bypass copy stays neutral about which emails exist.

### Password reset (`/reset/request`, `/reset/set`)

Request: one email field; the response is deliberately non-enumerating ("if an account exists…") — the design must present that neutrally, not as an error. Set: token hidden when present in the URL (F5); the page is just "choose a new password" with the live requirements checklist; visible token field only as the no-token fallback. Unique titles (F13).

### Forced password upgrade (`/password-upgrade`)

Same skeleton as reset/set with the explanatory paragraph. Tone matters: this interrupts a sign-in, so the copy must say why, what happens next, and nothing else.

### Logout (`/logout`)

Becomes the *post-logout* page ("You're signed out" + sign-in link) and the no-JS/no-header fallback for triggering logout. The primary logout affordance moves to the shared header (F2).

### Account Settings (`/account`)

Job: manage the personal account. Remove: Stored Data section (fixed constraint), all Refresh buttons (F4), the stray mid-page Log Out link (F2, F3). Section order, grouped under labelled landmarks with an in-page table of contents (anchor links — no JS):

1. **Emails** — list (primary/verified badges per F9, row actions named per A10) + add-email form with co-located feedback (F8).
2. **Security** — password change (live requirements), 2FA status/setup/remove, passkeys, linked accounts. These are siblings under one "Security" heading.
3. **Sessions** — current sessions list + "terminate all others" (danger-styled, named confirm).
4. **Organisations** — the directory described in the IA section.

Layout: single column with sticky in-page nav is the default recommendation; tabs are the alternative (Open question). Every list keeps its `HX-Trigger`-driven auto-refresh.

### Organisation Settings (`/organisations/:org_uuid`)

Job: run one organisation. The `h1` is the organisation's name (F11). Capability-gated sections (the `read` fragment already branches on `can()`):

1. **Profile** — rename.
2. **Teams** — create, list, per-team detail.
3. **Members** — list with roles; add member and invite forms; role `<select>`s gain one-line descriptions of each role (F11).
4. **Invitations** — pending list (invite-capable callers only).
5. **Billing** — a prominent link card to the billing page.
6. **Danger zone** — Disable/Enable and Delete, visually separated, confirms naming the org (F12).

### Organisation Billing (`/organisations/:org_uuid/billing`)

Keep the three-section shape (subscriptions, payment methods portal, invoices). Breadcrumb back to the org. Empty states get real copy ("No invoices yet"), not bare tables. Indicator/alt fix (A12).

### Invite accept (`/invite`) and federated signup (`/federated-signup`)

Both are "preview, then one affirmative action" pages — keep them that way. One card stating exactly what will happen ("Join *Acme* as *member*" / "Create an account for *name, email* from *GitHub*"), one primary button, one decline path. These pages are entered from emails/providers, so they must stand alone: full design-system styling, clear titles, no assumed context.

### OAuth consent (`/oauth/authorize`)

The highest-leverage redesign in the phase (F10). Adopt the design system (stylesheet + viewport). Content: which app, the scopes in plain language (`SCOPE_DESCRIPTIONS` already exists — render the descriptions as the primary text, the raw scope as secondary `<code>`), the org picker as a proper `fieldset`/`legend` radio group (already is — style it), and **Approve / Deny with equal visual weight, Deny not styled as a ghost** — consent must be a real choice. The error page (`buildConsentPage`'s sibling) gets the same treatment.

### Fragments (all list/status endpoints)

Shared rules, enforced by the [class contract](#the-fragment-class-contract): tables with captions and `scope` (A9); row actions named (A10) and sized (A11); badges from the defined set (F9); messages through the standard helpers with non-colour state (A4) into live-region areas (A1); destructive actions always `hx-confirm` with the object named (F12); empty states are sentences, not empty tables.

## Design-system requirements

All in `public/assets/main.css`, as CSS custom properties + plain selectors. No preprocessor, no utility framework.

- **Tokens**: colour (background, surface, text, muted text, border, accent, success, danger, warning — every text/background pair ≥ 4.5:1, every control border/focus ring ≥ 3:1 per A5), a 4px-base spacing scale, a small type scale (system font stack stays), radius, shadow, focus-ring (A6).
- **Components** (each with default / hover / focus-visible / disabled / busy states):
  - Buttons — keep the three semantic variants and **keep the class names** `.btn-safe` / `.btn-danger` / `.btn-save` (the rename cost across ~50 fragment files outweighs nicer names; see contract). Add a quiet/secondary variant for non-primary actions (e.g. Deny, Cancel, row actions that aren't destructive). Min target size per A11. Full-width only inside narrow auth cards; auto-width in dashboards.
  - Inputs + `.form-group` — labels above, hint/error slots wired for `aria-describedby` (A13), `:user-invalid` styling.
  - Status messages — `.result-area` as live region (A1) with `.result-positive` / `.result-negative` keeping their class names, gaining icon/prefix (A4).
  - Badges — define `.badge` + semantic variants to replace the dead Bootstrap classes (F9).
  - Tables/lists — responsive behaviour on narrow screens (decision: horizontal scroll wrapper vs stacked rows — designer's call, applied consistently).
  - Cards (org directory), section headers (replacing the `grid-header` float-ish layout), danger zone, `<details>/<summary>`, skip link, visually-hidden utility.
  - Loading indicator — CSS-based, reduced-motion-aware (A7), decorative (A12).
- **Dark mode** via `prefers-color-scheme` is cheap once tokens exist — SHOULD, decided in the design phase (Open question).
- **Print/no-JS**: pages must render readable, properly labelled forms before HTMX loads; HTMX progressively enhances.

## Accessibility requirements (normative)

The execution phase MUST satisfy, on every page and fragment:

1. **Landmarks & headings** — `<main>` everywhere; logical heading order, no skips (A2, F11).
2. **Skip link** on pages with the shared header (A3).
3. **Status messages** announced via pre-existing live regions; errors perceivable without colour (A1, A4 — WCAG 4.1.3, 1.4.1).
4. **Contrast** — 4.5:1 text, 3:1 non-text (A5 — 1.4.3, 1.4.11).
5. **Visible focus** on all interactive elements (A6 — 2.4.7).
6. **Reduced motion** respected by every animation (A7).
7. **Forms** — persistent labels, programmatic hint/error association, correct `autocomplete`/`inputmode` everywhere (A13, F6 — 1.3.5, 3.3.1–3.3.3).
8. **Named actions** — every row action and confirm identifies its object (A10, F12 — 2.4.6).
9. **Target size** ≥ 24×24 CSS px (A11 — 2.5.8).
10. **Unique, front-loaded page titles** (F13 — 2.4.2).
11. **Keyboard-only completion** of every flow in the [Verification](#verification) matrix (2.1.1, no traps).
12. **Tables** with captions and header scope (A9 — 1.3.1).

## The fragment class contract

The CSS classes are a contract between `main.css` and **~50 TypeScript files** that emit HTML (every `functions/api/**` list/status endpoint, the page shells in `functions/`, and helpers in `src/utilities/` — notably `responses.ts`, `members-endpoint.ts`, `login-response.ts`, `oauth-authorize.ts`, `error-page.ts`). Rules for the execution phase:

- **Keep existing class names working** (`.btn-*`, `.result-*`, `.container`, `.grid-container`, `.form-group`, `.spacer-*`, `.tfa-*`): restyle behind the names. New classes are **additive**.
- A rename or removal is allowed only with a lockstep sweep of all emitters in the same stage, verified by grep (the HTMX-4 migration's lesson: fragments are easy to miss — its execution notes found 10 stragglers).
- Centralise message markup in `src/utilities/responses.ts` so A1/A4 land in one place; hand-rolled `result-positive`/`result-negative` strings in endpoints migrate to the helpers as they're touched.
- Fragment markup changes (captions, `aria-label`s, badges) count as UI work and belong to this phase; fragment *behaviour* (status codes, envelopes, auth) does not.

## Staging (future execution phase)

Each stage ships independently; `npm run lint && npm run build && npm test` green at every step.

- [ ] **Stage 1 — Design system.** Rewrite `main.css` (tokens + components) keeping all existing class names rendering sensibly; define `.badge` variants and resolve `form-input` (F9); new loading indicator (A7, A12); focus styles (A6); palette (A5). Add the stylesheet + viewport to the consent screen and error page (F10) — markup otherwise untouched. Lowest-risk, highest-coverage stage.
- [ ] **Stage 2 — Message + fragment groundwork.** `responses.ts` helpers gain live-region/non-colour state (A1, A4); fragment sweep for captions, scope, named actions, confirms, empty states (A9–A11, F12).
- [ ] **Stage 3 — Signed-out flow.** Root redirect (F1, deletes `index.html`'s index); rebuild login, register, 2FA, reset ×2, password-upgrade, logout-as-confirmation (F2, F5–F7, F13, A13, A14).
- [ ] **Stage 4 — Account Settings.** Restructure per brief: remove Stored Data + Refresh buttons, shared header + skip link, section order, in-page nav (F2–F4, F8, A2, A3).
- [ ] **Stage 5 — Organisation surfaces.** Org page (h1, role descriptions, danger zone — F11), billing page, invite, federated-signup, consent-screen content polish.
- [ ] **Stage 6 — Verification pass.** The full matrix below; fix-forward.

## Verification

Unit tests cover none of this (they run in Node, no browser); several fragment tests assert emitted HTML and **will** need updating alongside markup changes. Manual gates per stage:

- [ ] **Keyboard-only walkthrough** of every flow: register → verify email → login (password / passkey / provider) → 2FA (+ bypass) → account sections → org create/manage → invite accept → billing → consent approve+deny → logout → reset → password-upgrade.
- [ ] **Screen reader smoke test** (NVDA/Firefox and VoiceOver/Safari): every form submission's outcome is announced; lists are navigable tables; headings/landmarks navigate sensibly.
- [ ] **axe-core (or Lighthouse a11y) clean** on every page incl. server-rendered ones and the consent screen.
- [ ] **Reduced-motion, 200% zoom, and 320px-wide** checks.
- [ ] **Dark mode contrast re-check** (if adopted).
- [ ] `npm run lint && npm run build && npm test` after each stage; grep-sweep for orphaned class names after any rename.

## Open questions / decisions for the design phase

- **Account layout**: single column + sticky in-page nav (default) vs tabs.
- **Header identity** ("signed in as …") needs a small whoami fragment endpoint — new backend surface, so: ship the header without identity first, or add the endpoint in Stage 4?
- **Dark mode** now (tokens make it cheap) or as a follow-up?
- **Password visibility toggle** on password fields (small vanilla-JS module) — include or skip?
- **Table responsive strategy**: scroll wrapper vs stacked rows.
- **`/api/user/exists` live check on register** intentionally reveals account existence while reset/request hides it. Existing, deliberate behaviour — the UI phase only needs consistent copy; flag if the designer thinks it reads as contradictory.

## Out of scope

- Backend behaviour: endpoints, auth tiers, envelopes, status codes, enumeration posture.
- Key-value UI (excluded by decision, not deferred) and any operator/admin UI.
- Email templates and actual email delivery (separate production blocker).
- New features (account deletion UI, org transfer, etc.) — IA leaves room; this phase doesn't build them.
- i18n / translations.
- HTMX version work (Phase 10) and any JS framework adoption (excluded by constraint).
