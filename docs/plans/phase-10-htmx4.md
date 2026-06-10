# Phase 10 — HTMX 4

The frontend is driven **entirely** by HTMX: static HTML under `public/`, server-rendered HTML from a handful of `functions/`, no custom client-side JS (the lone exception is `assets/webauthn.js`, a self-contained passkey module that hooks a single HTMX lifecycle event), and API endpoints that return **HTML fragments, not JSON**. HTMX 4 is in beta (`4.0.0-beta4`, already vendored). This phase is a **planning document only** — it inventories current usage, enumerates the HTMX 4 breaking changes that actually affect this repo, and lays out a staged migration with a verification and rollback checklist. No pages, build config, or CSP are touched here.

## Table of Contents

- [Context](#context)
- [Decisions](#decisions)
- [What the official `upgrade-check` reports](#what-the-official-upgrade-check-reports)
- [Current-state inventory](#current-state-inventory)
- [Breaking-change impact](#breaking-change-impact)
- [Attribute inheritance (the subtle one)](#attribute-inheritance-the-subtle-one)
- [The `hx-prompt` removal](#the-hx-prompt-removal)
- [The `webauthn.js` event rename](#the-webauthnjs-event-rename)
- [Migration steps (future execution phase)](#migration-steps-future-execution-phase)
- [Per-file checklist](#per-file-checklist)
- [Verification / test matrix](#verification--test-matrix)
- [Rollback](#rollback)
- [Open questions / VERIFY-on-stable](#open-questions--verify-on-stable)
- [Sources](#sources)
- [Out of scope](#out-of-scope)

## Context

There is no rush — HTMX 2.x remains supported, and 4.0 is still beta. The value of doing this now is that the surface area is small and well-bounded, and capturing it while the code is fresh means the swap can be executed in an afternoon once 4.0 stabilises. Every claim below was checked against three sources: the official migration guide, the official `npx htmx.org@next upgrade-check` run captured in [`phase-10-htmx4-check.txt`](./phase-10-htmx4-check.txt), and the vendored `public/assets/htmx_4.0.0-beta4.js` source (line numbers cited inline). Beta-dependent items that could still shift before stable are marked **VERIFY**.

## Decisions

- [x] **No `htmx-2-compat` shim.** Migrate to native HTMX 4 idioms rather than loading the compatibility extension. That shim exists precisely to restore implicit inheritance, old event names, and the old error-swapping defaults — i.e. it would paper over the [inheritance findings](#attribute-inheritance-the-subtle-one) instead of resolving them. We handle each natively.
- [x] **Pinned target: `htmx_4.0.0-beta4.min.js`** (the IIFE build, already vendored at `public/assets/`). We load HTMX via a plain `<script src>` tag, not as a module, so the IIFE build is correct and the `.esm.*` variants are unused.
- [x] **Keep versioned filenames.** Pages load `/assets/htmx_2.0.4.min.js` by explicit version — not a stable `/htmx.min.js` alias — so bumping the filename is itself the cache-bust. `public/_headers` has no `/assets/*` immutable rule, so there is no stale-cache trap.

## What the official `upgrade-check` reports

`npx htmx.org@next upgrade-check` was run against the tree (output in `phase-10-htmx4-check.txt`). Filtering out `node_modules/` and the `dist/worker/` build artifact (regenerated, never hand-edited), the actionable findings are:

- **`responseHandling` config removed** — every page that sets it: all 8 static HTML pages **plus 3 server-rendered functions** (`functions/invite.ts`, `functions/organisations/[org_uuid].ts`, `functions/organisations/[org_uuid]/billing.ts`).
- **`hx-disabled-elt` → `hx-disable`** rename.
- **`hx-prompt` removed** (`account.html`, the add-email control).
- **Explicit-inheritance `:inherited` needed** on 4 pages: `register`, `password-upgrade`, `reset/set`, `account`.
- **One first-party `[old-event]` hit:** `public/assets/webauthn.js:228` registers an `htmx:afterRequest` listener that v4 renames to `htmx:after:request` — see [the dedicated section](#the-webauthnjs-event-rename) and [breaking-change row 10](#breaking-change-impact). (This finding is new: the latest `upgrade-check` run scans `.js` files, where the earlier run did not, which is why it now appears.)
- The _rest_ of the long `[old-event]` / `[removed-event]` / `[removed-header]` list all points at `public/assets/htmx_2.0.4.min.js` itself — those are the _old library's_ internals, not our code. We use no `hx-on` handlers and set none of the removed headers server-side (`grep HX-Trigger-After` → none), so they are **N/A** once the old file is deleted.

**Tool reliability caveat:** `upgrade-check` reliably detects `responseHandling` (a config string) inside both `.html` and `.ts` files, but its **attribute-level detection inside `functions/*.ts` template literals is incomplete** — it flagged the `responseHandling` in `billing.ts` but _missed_ the `hx-disabled-elt=".btn-safe"` in the same file. **Therefore the server-rendered `.ts` pages must be reviewed by hand**, not trusted to the tool. Counting that missed one, there are **15** `hx-disabled-elt` occurrences to rename (14 in HTML + ≥1 in `billing.ts`).

## Current-state inventory

Confirmed from the working tree as of this writing:

- **Version in use: HTMX 2.0.4**, loaded via `<script src="/assets/htmx_2.0.4.min.js"></script>`.
- **11 files load HTMX and embed the `htmx-config` meta:**
  - 8 static: `register`, `login`, `logout`, `password-upgrade`, `2fa`, `account`, `reset/request`, `reset/set` (`index.html` loads no HTMX).
  - 3 server-rendered: `functions/invite.ts`, `functions/organisations/[org_uuid].ts`, `functions/organisations/[org_uuid]/billing.ts` (each emits the same `<head>` boilerplate from inside the handler).
- **HTMX 4.0.0-beta4 is already vendored** in four builds under `public/assets/`: `htmx_4.0.0-beta4.min.js` (IIFE min, target), `htmx_4.0.0-beta4.js` (IIFE readable), and `.esm.min.js` / `.esm.js` (unused).
- **`responseHandling` shapes vary:** static pages enumerate `200/400/401/403/404/405/500` (all `swap:true`); `billing.ts` uses the wildcard `{"code":".*","swap":true}`. Both mean "swap success and error responses."
- **Attribute usage (static pages):** `hx-target` 23, `hx-swap` 21, `hx-post` 19, `hx-get` 17, `hx-trigger` 16, `hx-disabled-elt` 14, `hx-include` 7, `hx-validate` 6, `hx-sync` 5, `hx-confirm` 2, `hx-prompt` 1. **No `hx-on`, `hx-headers`, `hx-boost`, `hx-push-url`, or `hx-swap-oob` anywhere.**
- **Every explicit `hx-swap` is `"innerHTML"`** (21×); requests that omit it rely on the default, which is _also_ `innerHTML` in v4 (config line 120), so they are unaffected.
- **Live-validation pattern:** several forms (`register`, `password-upgrade`, `reset/set`, `account`'s change-password) wrap an `<input>` that fires its own keyup-triggered `hx-get`/`hx-post` to a requirements/exists endpoint. This is the inheritance hotspot — see below.
- **Indicators:** `.htmx-indicator` + `bars.svg` inside buttons; `htmx-request` is the active class. Both class names are HTMX 4 defaults (config lines 121–122), so the pattern carries over untouched (HTMX 4 also self-injects indicator CSS via `includeIndicatorCSS:true`, line 124 — at worst a harmless double-definition with `main.css`).
- **`webauthn.js`** (passkeys, **first-party**) loads on `login.html` and `account.html` as an independent `<script defer>`. It touches HTMX in exactly one place: `loginForm.addEventListener("htmx:afterRequest", …)` at line 228, which records a successful sign-in. That event name is renamed in v4 — see [the dedicated section](#the-webauthnjs-event-rename).
- **Server-side HTMX headers:** handlers read `HX-Request` (branch HTMX-nav vs. plain `Location`) and `HX-Prompt` (one site: `functions/api/email/add.ts`), and set `HX-Redirect` / `HX-Trigger`. None read `HX-Target`; none set the removed `HX-Trigger-After-Swap`/`-Settle`.

## Breaking-change impact

Each row: the HTMX 4 change × our exposure × the native action (no compat) × residual risk.

| #   | HTMX 4 change                                                                                                                                                             | Our exposure                                                              | Native action                                                                                                                                          | Risk                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`responseHandling` config removed.** v4 swaps _all_ responses except `204`/`304` (`config.noSwap = [204, 304]`, source line 129; `#handleStatusCodes` lines 2151-2166). | 11 files set it (8 static + 3 server-rendered).                           | **Delete the `responseHandling` block** from each. The repo's intent (swap every listed code) _is_ the v4 default, so behaviour is preserved natively. | Low — **VERIFY** no endpoint returns `204`/`304` where a swap was expected (fragment endpoints return explicit bodies, so unlikely). |
| 2   | **`hx-disabled-elt` renamed to `hx-disable`** (the old `hx-disable` skip-processing role moves to `hx-ignore`; both exist in beta4).                                      | 15 occurrences (14 HTML + ≥1 in `billing.ts` the tool missed).            | **Rename `hx-disabled-elt=` → `hx-disable=`**; values (`.btn-safe`, `.btn-save`, `this`, `button`, `#logoutButton`) carry over.                        | Medium — highest-volume change. **VERIFY** beta4's `hx-disable` means "disable during request" before bulk-renaming.                 |
| 3   | **Explicit attribute inheritance** (`config.implicitInheritance = false`, line 131; opt in with `:inherited`; `hx-inherit`/`hx-disinherit` gone).                         | 4 pages — see [dedicated section](#attribute-inheritance-the-subtle-one). | Per-page review: drop the now-unneeded inheritance (recommended) or add `:inherited`.                                                                  | Medium.                                                                                                                              |
| 4   | **`hx-prompt` removed.**                                                                                                                                                  | 1 usage (`account.html` add-email; read via `HX-Prompt`).                 | See [dedicated section](#the-hx-prompt-removal).                                                                                                       | Medium (mechanism, not logic).                                                                                                       |
| 5   | **Default `hx-swap`** — _unchanged_, still `innerHTML` (`config.defaultSwap`, line 120). The common "v4 → outerHTML" claim is false for beta4.                            | All swaps are `innerHTML`.                                                | None.                                                                                                                                                  | None.                                                                                                                                |
| 6   | **`hx-sync`** owns all request queuing (the `hx-trigger` queue modifier was removed; we use no queue modifier).                                                           | 5× `hx-sync="closest form:abort"`.                                        | None.                                                                                                                                                  | Low — **VERIFY** `closest form:abort` syntax unchanged.                                                                              |
| 7   | **`hx-confirm`** gains `js:` prefix; needs `:inherited` to inherit.                                                                                                       | 2× (`account.html`), co-located with the request.                         | None (not inherited).                                                                                                                                  | Low.                                                                                                                                 |
| 8   | **`hx-validate` / `hx-trigger`** (`load`, `keyup changed delay`, `… from:body`).                                                                                          | 6× / 16×. Present in beta4.                                               | None.                                                                                                                                                  | Low — **VERIFY** syntax unchanged.                                                                                                   |
| 9   | **`hx-target`** request-header format → `tagName#id`.                                                                                                                     | No handler reads `HX-Target`.                                             | None.                                                                                                                                                  | None.                                                                                                                                |
| 10  | **Removed/renamed events/headers** (`htmx:afterRequest`→`htmx:after:request`, validation events, `HX-Trigger-After-Swap/Settle`).                                         | `webauthn.js:228` listens for `htmx:afterRequest`; no `hx-on`/headers.    | **Rename the listener → `htmx:after:request`** (see [section](#the-webauthnjs-event-rename)); validation events / headers are unused.                  | Low — coupled to the `login.html` + `account.html` bump.                                                                             |

## Attribute inheritance (the subtle one)

The `upgrade-check` flags inheritance on `register`, `password-upgrade`, `reset/set`, and `account`. The shape is always the same: a `<form>` carries attributes for its **own** submit (`hx-target`, `hx-include`, sometimes `hx-disabled-elt`/`hx-swap`), and a live-validation `<input>` _inside_ it issues its **own** `hx-get`/`hx-post`. In htmx 2 that descendant implicitly inherits the form's attributes; in v4 it will not.

On inspection, **each descendant input already sets its own `hx-target`** (`#email-exists`, `#password-requirements-output`) **and its own `hx-include="this"`** where relevant — so it _overrides_ those and does not actually rely on inheriting them. The tool over-flags `hx-target`/`hx-include` because it only sees "parent has attr, descendant makes a request," not the override.

The only attributes the descendant passively inherits are **`hx-disabled-elt`** (so today a keyup-validation request also disables the form's submit button) and **`hx-swap`** (harmlessly `innerHTML` either way). So:

- **Recommended (cleaner):** do **not** add `:inherited`. Let v4's explicit-inheritance default stand. The behavioural delta is that live-validation keystrokes will no longer disable the submit button — neutral-to-better. Confirm per page that each descendant sets the target it needs (it does today).
- **Alternative (byte-for-byte parity):** add `:inherited` to the flagged parent attributes — note the rename interaction: `hx-disabled-elt` becomes **`hx-disable:inherited`**.

**VERIFY** during execution by exercising each live-validation field after the swap.

## The `hx-prompt` removal

`account.html`'s add-email control is a single `<button name="email_address" hx-post=… hx-prompt="Enter an email address to add:" hx-confirm="…">`. On click htmx prompts, confirms, then POSTs with the typed value in the `HX-Prompt` header. `functions/api/email/add.ts` reads that header (its comment notes it's "more reliable when the `hx-prompt` is on a button element"), with the form field `email_address` as a fallback.

HTMX 4 removes `hx-prompt`. Native paths:

- **(Recommended) Convert to a real `<input name="email_address">` + submit button**, matching every other form in the repo, and drop the `HX-Prompt` header entirely. `add.ts` already accepts the field value, so the server likely needs only to drop the header branch. This avoids inline JS and keeps CSP untouched.
- **(Alternative) `hx-confirm="js:…"`** to prompt-and-confirm in one expression (`js:` exists in beta4). But getting the captured value to the server is not a drop-in for `HX-Prompt`, and a `js:` expression is eval-adjacent — relevant to the `script-src` CSP. Only if the input-field path is rejected.

**VERIFY**: confirm `add.ts`'s field fallback fully covers the value once the header path is gone, and update its comment.

## The `webauthn.js` event rename

`public/assets/webauthn.js` is **first-party** code (a self-contained passkey module), not a vendored library — so the one HTMX touchpoint inside it is ours to migrate, unlike the rest of the `[old-event]` noise that lives in `htmx_2.0.4.min.js`. At line 228 it attaches `loginForm.addEventListener("htmx:afterRequest", …)` to record a successful password sign-in (every success returns an `HX-Redirect`, which this listener detects to remember the email for the next visit). HTMX 4 renames this event to **`htmx:after:request`**. The fix is a one-line string change.

The catch is coupling: `webauthn.js` is a **single shared file loaded by both `login.html` and `account.html`**, and the listener only fires for whichever event name the loaded HTMX version dispatches. So the rename cannot be staged independently — it must land in the **same step that bumps both `login.html` and `account.html` to v4**. A page still on v2 with the renamed listener (or a v4 page with the old name) silently stops recording logins: nothing errors, the passkey auto-offer just goes stale.

**VERIFY**: after the swap, sign in with a password on `login.html` and confirm the email is remembered (a passkey is auto-offered on the next visit).

## Migration steps (future execution phase)

- [ ] **Stage A — pilot one page.** Repoint the script tag on a single low-risk static page (`logout.html`) to `htmx_4.0.0-beta4.min.js`, delete its `responseHandling`, rename its `hx-disabled-elt`. Smoke-test end to end.
- [ ] **Stage B — resolve the VERIFY items** on a page that exercises them (`register.html`): `hx-disable` runtime behaviour, the inheritance decision on live-validation, `hx-sync`/`hx-trigger`/`hx-validate` syntax.
- [ ] **Stage C — roll out to the remaining static pages**, then the **3 server-rendered functions** (hand-reviewed, since the tool under-reports their attributes). Handle the `account.html` `hx-prompt` rewrite + `email/add.ts` follow-up together. Bump `login.html` and `account.html` in the **same step** as the `webauthn.js` `htmx:afterRequest` → `htmx:after:request` rename — they share that file and cannot straddle versions (see [the `webauthn.js` event rename](#the-webauthnjs-event-rename)).
- [ ] **Stage D — clean up:** delete `htmx_2.0.4.min.js` and the unused `.esm*.js` builds (optionally keep the readable `.js` for debugging); update `.github/instructions/frontend.instructions.md` and `docs/Architecture.md` (script src, removed `responseHandling`, `hx-disabled-elt`→`hx-disable`, explicit inheritance).

## Per-file checklist

Static HTML (repoint script → strip `responseHandling` → rename `hx-disabled-elt` → inheritance review where noted):

- [ ] `public/login.html` — loads `webauthn.js` (**rename coupling** — bump with `account.html`)
- [ ] `public/register.html` — **inheritance** (form → email-exists input)
- [ ] `public/logout.html`
- [ ] `public/password-upgrade.html` — **inheritance**
- [ ] `public/2fa.html`
- [ ] `public/account.html` — **inheritance** (change-password form) + **`hx-prompt` rewrite** + 6× `hx-disable` + loads `webauthn.js` (**rename coupling** — bump with `login.html`)
- [ ] `public/reset/request.html`
- [ ] `public/reset/set.html` — **inheritance**

First-party JS:

- [ ] `public/assets/webauthn.js` — rename `htmx:afterRequest` → `htmx:after:request` (line 228); ship in the same step as the `login.html` + `account.html` bump

Server-rendered (hand-review — tool under-reports attributes in `.ts`):

- [ ] `functions/invite.ts` — script + `responseHandling`
- [ ] `functions/organisations/[org_uuid].ts` — script + `responseHandling`
- [ ] `functions/organisations/[org_uuid]/billing.ts` — script + `responseHandling` + 1× `hx-disable` (tool missed)

## Verification / test matrix

Unit tests (`vitest`) run in plain Node and **never touch the browser**, so they will not catch an HTMX regression. `npm run lint` + `npm run build` confirm the pages compile and Prettier is happy, but manual browser smoke-testing is **mandatory** per flow:

- [ ] Register (live email-exists + password-requirements; verify the inheritance change)
- [ ] Login — password, passkey, federated provider buttons; after a password sign-in, confirm `webauthn.js` still records the email (passkey auto-offered next visit) — exercises the `htmx:after:request` rename
- [ ] 2FA code entry + "lost authenticator?" bypass
- [ ] Password upgrade (forced) — live password-requirements field
- [ ] Logout
- [ ] Password reset — request, then set (live field)
- [ ] Account dashboard: add/remove email (rewritten control), sessions + terminate-others, password change (live field), 2FA enable/disable, passkeys, linked accounts, organisations, stored data
- [ ] Server-rendered pages: invite accept, org management panel, org billing panel
- [ ] Confirm error responses (400/401/etc.) still render their fragment with `responseHandling` removed
- [ ] `npm run lint && npm run build && npm test`

## Rollback

Revert the script `src` on affected files to `/assets/htmx_2.0.4.min.js` and restore the `responseHandling` blocks. Keep `htmx_2.0.4.min.js` vendored until the beta is validated across all flows — do not delete it before Stage D passes.

## Open questions / VERIFY-on-stable

- All rows/items marked **VERIFY** — re-check against the _final_ 4.0 migration guide when 4.0 stable ships (the current guide self-describes as early/in-progress) and re-run `upgrade-check`.
- Whether to keep pinning a specific beta or track the latest 4.0.x at execution time.
- Whether to take the optional CSP tightening (`script-src 'unsafe-inline'`) — only relevant if the `hx-prompt` replacement uses `js:`; the recommended input-field path keeps CSP out of scope.

## Sources

- Official migration guide: `https://four.htmx.org/docs/get-started/migration` (beta, in progress).
- Official tool output: [`phase-10-htmx4-check.txt`](./phase-10-htmx4-check.txt) — `npx htmx.org@next upgrade-check`, 72 issues across 16 files (incl. `node_modules`/`dist`; the actionable subset is described above). The latest run scans `.js` files (3247 scanned, up from 2942), which is what surfaced the `webauthn.js` finding.
- Vendored source (authoritative for beta4): `public/assets/htmx_4.0.0-beta4.js` — config defaults lines 115-132 (`defaultSwap`, `noSwap`, `implicitInheritance`, indicator classes), status handling `#handleStatusCodes` lines 2151-2166.

## Out of scope

- Any actual code change to `public/`, `functions/`, `src/`, `_headers`, or build config — all deferred to the execution phase.
- Adopting morphing swaps (first-class in v4) — opportunity, not a requirement.
- Tightening the `script-src` CSP.
- Loading the `htmx-2-compat` shim (explicitly rejected — see [Decisions](#decisions)).
