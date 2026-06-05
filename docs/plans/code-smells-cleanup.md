# Code Smells Cleanup

Triage and remediation plan for `qlty smells --all`. Run on 2026-06-05 against 260
files; ~145 findings. This document records which findings we **act on**, which we
**deliberately leave**, and why — so the list never has to be re-triaged from scratch.

`qlty smells` is **not a CI gate** (CI runs Prettier `--check`, `tsc`, and the build;
smells are dashboard-only — see `.qlty/qlty.toml`). So nothing here blocks a push; this
is voluntary quality work, and "leave it" is a legitimate, documented outcome.

## Table of Contents

- [The one-line thesis](#the-one-line-thesis)
- [Layering lens](#layering-lens)
- [What we are NOT touching (and why)](#what-we-are-not-touching-and-why)
- [What we ARE doing — duplication, tiered by risk](#what-we-are-doing--duplication-tiered-by-risk)
  - [Tier A — mechanical (within-file twins)](#tier-a--mechanical-within-file-twins)
  - [Tier B — model symmetry (org ↔ team)](#tier-b--model-symmetry-org--team)
  - [Tier C — sensitive (billing ↔ entitlements)](#tier-c--sensitive-billing--entitlements)
- [Working method](#working-method)
- [Execution plan](#execution-plan)
- [Out of scope](#out-of-scope)

## The one-line thesis

**The only smell category worth acting on is duplication, and all of it lives in the
model layer (`src/`).** Every "many returns" / "high complexity" / "deeply nested" /
"high total complexity" finding is the codebase's deliberate **guard-clause +
structured-envelope idiom**, which `CLAUDE.md` and `.github/instructions/backend.instructions.md`
*mandate* ("Validate all input at the top of the handler, before any DB or
business-logic call"). Collapsing those returns means re-nesting into `if/else`
pyramids — strictly worse. We leave them.

## Layering lens

(Per the maintainer's framing — the smells map cleanly onto it.)

- `functions/api/**` → **controllers**. Linear validate-then-act handlers. Their
  complexity/returns are inherent. **No duplication findings of substance** (the only
  one is a false positive — see `enable`/`disable` below).
- `src/**` → **models**. Where every genuine duplication finding lives, and the only
  place we refactor.
- `public/**` → **views**. One finding (`webauthn.js` complexity 57); inherent, left.

## What we are NOT touching (and why)

Documented so we don't reconsider these every time the report is run.

### Guard-clause / envelope complexity — INHERENT, LEAVE

~85 findings across these categories: `Function with many returns`,
`Function with high complexity`, `High total complexity`, `Deeply nested control flow`.
Root cause is the mandated idiom (top-of-handler validation returning
`resultNegative(...)`; `src/` functions returning `{ success } | { error } | { exists }`
envelopes rather than throwing). The branch count *is* the validation surface.

The scary-looking outliers (complexity ≥ 30), all **reviewed and accepted**:

- `functions/oauth/token.ts` — 81 (multi-grant-type token endpoint)
- `functions/oauth/userinfo.ts` — 60 + nesting level 4
- `functions/login/[provider]/callback.ts` — 44
- `src/passwords.ts` — `passwordRequirementsHtml` 42 (HTML string assembly), file total 100
- `functions/api/db/password/upgrade.ts` — 41
- `functions/api/billing/usage/[app_uuid].ts` — 37
- `functions/api/db/auth/organisations/[org_uuid]/read.ts` — 33
- `functions/api/db/federated-signup/confirm.ts` — 33
- `functions/api/db/auth/2fa/setup/verify.ts` — 32
- `src/utilities/oauth-token.ts` — `buildIdToken` 33
- `functions/api/csp-report.ts` — 30

> **Refinement (maintainer call):** controller complexity is *not* acceptable when the
> function reasonably contains **extractable logic** — only the irreducible
> validate-then-return guard surface is. `oauth/token.ts` (81) and `oauth/userinfo.ts`
> (60) crossed that line, so they were decomposed — see [Tier D](#tier-d--controller-decomposition-done).
> The remaining controller complexity findings are pure guard clauses with nothing to
> extract, and stay.

### Test duplication — LEAVE

11 findings across `test/*.test.ts` (e.g. `2fa`↔`sessions`, `organisations`↔`teams`,
`passkeys`↔`memberships`, the identical 26-line block in `oauth-jwt`↔`oauth-keys`).
Similar arrange/setup blocks. Test independence and read-in-isolation clarity outweigh
DRY here; shared fixtures would couple unrelated suites. Left as-is. (If the
`oauth-jwt`/`oauth-keys` identical block ever drifts, a single shared helper in
`test/helpers/` is the escape hatch — not needed now.)

### False positive — `enable.ts` / `disable.ts` — LEAVE

`functions/api/db/auth/organisations/[org_uuid]/{enable,disable}.ts` (dup, mass 138).
Structurally identical but **semantically distinct endpoints** differing only in
verb / event (`ORG_ENABLED` vs `ORG_DISABLED`) / message. DRYing them behind a shared
factory couples two independent controllers behind a flag, for no real gain. Each file
is 27 lines and reads cleanly in isolation. Left.

### `public/assets/webauthn.js` complexity 57 — LEAVE

First-party (per memory: not a vendor file), but the complexity is the ceremony of the
browser WebAuthn API (credential creation/assertion, base64url plumbing), not accidental
tangling. Left.

### "Complex binary expression" ×2 — LEAVE (or trivial)

`functions/api/db/user/register.ts` and `src/oauth-keys.ts`. Each is a single boolean
expression flagged for term count. Only worth a named-const extraction *if* we are
editing those lines anyway for another reason.

## What we ARE doing — duplication, tiered by risk

All 24 genuine duplication findings are in `src/`. Grouped by risk so we can stop after
any tier with the tree green. **Invariant for every change: public function signatures
and their JSDoc stay exactly as-is.** We only extract *private* helpers behind them, so
no caller and no test changes.

### Tier A — mechanical (within-file twins)

Two/three near-identical functions in one file; extract one private helper, the public
functions become thin one-liner delegates. Near-zero risk. ~14 findings.

- **`src/mailer.ts`** (dup ×3) — `sendVerificationEmail` / `sendPasswordResetEmail` /
  `sendTwoFactorBypassEmail` / `sendOrganisationInvitationEmail` are identical except
  link path, template fn, and category. All four build `${origin}${path}?token=...`.
  → private `sendTokenLinkEmail(env, to, path, token, buildContent, category)`; each
  public fn delegates. Drops ~40 lines. **(Already inspected — ready.)**
- **`src/tokens.ts`** (dup ×6) — `createLoginToken` / `createPasswordUpgradeToken` /
  `createBypassToken` / `createSudoToken` (+ `createEmailToken` / `createPasswordToken`)
  are wrappers over `createToken` differing only in `token_type`, TTL, and a log label.
  → one private helper taking `(token_type, ttlMs, label)`; keep named exports + JSDoc.
  - **Bonus observed:** the wrappers' outer `try/catch` is effectively **dead** —
    `createToken` already swallows its own errors and returns an envelope, and the only
    other statement (`new Date().toISOString()`) cannot throw. So the wrappers' custom
    "Server error while creating *X* token." messages never actually surface (the caller
    gets `createToken`'s generic message). The shared helper can drop the dead `try/catch`;
    behaviour is unchanged because it was already unreachable.
- **`src/apps.ts`** (dup ×4) — `readApp` / `readAppByClientId` differ only in the WHERE
  column (`app_uuid` vs `client_id`, both **literals**, never user input) and log label
  (the two 23-line dups). The 21/24-line dups are the `listAppTiers` / `listAppPermissions`
  pair. → `readAppBy(column, value)` (whitelisted column) + a shared list helper.
  **(Already inspected the read pair — ready.)**
- **`src/federated-signup-tokens.ts`** (dup ×2) — `readFederatedSignupToken` /
  `consumeFederatedSignupToken` share the lookup + expiry-check + envelope-mapping block.
  → extract the shared read/validate step.
- **`src/keyvalues-resolver.ts`** (dup ×2, 15 lines) — repeated resolution-step block
  inside `resolveKeyValue`. Extract the step helper. NOTE: the function's complexity (20)
  / many-returns (9) is the **resolver-precedence chain** and is *inherent* — only the
  duplicated block is addressed, not the branch count.
- **`src/users.ts`** (dup ×2, 17 lines) — a within-file repeated block (candidates:
  `disableUser`/`enableUser` or the two `getUserBy*` lookups — confirm at execution).
  Extract the shared block. NOTE: `loginUser` complexity (18) / many-returns (12) is
  inherent and left.

### Tier B — model symmetry (org ↔ team)

The org/team parallel-CRUD cluster. Genuine, but interlocked and touching
membership/role **writes inside transactions** — higher risk. Do as one focused unit
with the existing suites as the safety net (`test/memberships.test.ts`,
`test/organisations.test.ts`, `test/teams.test.ts`, `test/invitations.test.ts`). ~8 findings.

- **`src/memberships.ts`** internal (39/31/24/21/18-line dups) — `addOrgMember`↔`addTeamMember`,
  `setOrgMemberRoles`↔`setTeamMemberRoles`, `removeOrgMember`↔`removeTeamMember`,
  `getOrgRoles`↔`getTeamRoles`. The org/team variants are the same logic over different
  table/column names.
- **`src/organisations.ts` ↔ `src/teams.ts`** (28/24/17-line dups) — `create`/`update`/
  `delete` follow the same shape (name validation → `MAX_NAME_LENGTH` → write → envelope).
- **`src/invitations.ts` ↔ `memberships.ts` / `teams.ts`** (20/22-line dups) — shared
  role-assignment / validation blocks.
- **`src/organisations.ts` ↔ `memberships.ts`** (26-line, 3 locations).

Approach: introduce scope-parameterized private helpers keyed by `"org" | "team"` with a
small table/column map (e.g. `{ table, idColumn, roleTable }`), or shared validation
helpers (name length, membership existence). Keep every public function and its envelope
shape intact. Make the smallest extraction that kills each dup; re-run the four suites
after each.

### Tier C — sensitive (billing ↔ entitlements)

Money + licensing decisions. Smallest possible steps, most caution, **do last**. Lean on
`test/billing.test.ts` / `test/entitlements.test.ts` (confirm coverage first). ~8 findings.

- **`src/billing.ts`** internal (18×3, 22×3, 18×2, 21×2) — the provider-call +
  envelope-mapping wrappers (`createSubscription` / `updateSubscription` /
  `cancelSubscription` / `startSubscriptionCheckout` share "call provider → map throw to
  502 envelope → persist"). Extract a `withProvider`-style mapping helper. NOTE: file
  total complexity 105 and the per-function many-returns are the envelope idiom — only the
  duplication is touched.
- **`src/billing.ts` ↔ `src/entitlements.ts`** (24-line mass 65 on the billing side;
  50-line mass 65 reported from the entitlements side) — a shared
  licensing/entitlement-resolution block. **Care:** these are two modules sharing a
  concept; extract to a neutral spot (or have one import a small exported helper) to
  avoid a circular import. Decide direction before writing.
- **`src/entitlements.ts`** internal (18/14-line dups). NOTE: `isLicensed` (many-returns 10)
  / `assertGranteeInOrg` (6) branch counts are inherent and left.

## Working method

Per change, in this order:

1. Read the full function group (not just the flagged lines) before extracting.
2. Extract the **private** helper; rewrite the public functions as delegates. Public
   signatures + JSDoc unchanged.
3. `npm run typecheck` (strict) — must pass.
4. `npm test` — relevant suites green (the model layer is well covered; tests pass a fake
   `pg` client, so behaviour-preserving refactors should be invisible to them).
5. Re-run `qlty smells --all` to confirm the targeted finding(s) cleared without new ones.
6. `npm run lint` before any push.

Honour the repo's "manual fixes, no autoformat surprises" preference: no broad
reformatting, only the targeted extraction. One tier (or one file) per commit so each is
independently reviewable and revertible.

## Execution plan

- [x] **A1** `src/mailer.ts` — `sendTokenLinkEmail` helper; 4 delegates.
- [x] **A2** `src/tokens.ts` — shared `createTypedToken(type, ttlMs, email?)`; dropped the dead per-wrapper try/catch.
- [x] **A3** `src/apps.ts` — `readAppBy(column, value)` for the read pair + `listAppLicenseEntries` for the tiers/perms pair.
- [x] **A4** `src/federated-signup-tokens.ts` — shared `runSignupTokenQuery` for read/consume.
- [x] **A5** `src/keyvalues-resolver.ts` — `querySingleTier` (user/team/org/app) **and** `queryRoleTier` (team-role/org-role). The flagged 15-line pair was the role tiers; the single-value merge is a bonus sub-threshold dedup.
- [x] **A6** `src/users.ts` — `updateUserByUuid` unifying `enableUser` + `updateLastLogin` (the 17-line twins; `disableUser`/`deleteUser` are transactional, left).
- [x] **Tier A gate** — `tsc` strict clean; full suite 565/565 green; `npm run format` ✔ no issues; smells re-run shows all six files' duplication cleared (only the documented inherent `resolveKeyValue` / `loginUser` complexity remains).
- [ ] **B1** `src/memberships.ts` — scope-parameterized member/role helpers.
- [ ] **B2** `src/organisations.ts` ↔ `src/teams.ts` — shared create/update/delete + name validation.
- [ ] **B3** `src/invitations.ts` — shared role-assignment/validation with memberships/teams.
- [ ] **Tier B gate** — memberships/organisations/teams/invitations suites green; smells re-run.
- [ ] **C1** confirm `test/billing.test.ts` / `test/entitlements.test.ts` coverage is adequate first.
- [ ] **C2** `src/billing.ts` — provider-call/envelope mapping helper.
- [ ] **C3** `src/billing.ts` ↔ `src/entitlements.ts` — shared licensing block (decide import direction; no cycle).
- [ ] **C4** `src/entitlements.ts` — internal dedup.
- [ ] **Tier C gate** — billing/entitlements suites green; full smells re-run; `npm run lint`.
- [x] **D1** `functions/oauth/userinfo.ts` — claim assembly → `buildUserInfoClaims` + `resolveEntitlementsClaim` + `readEmailClaims` in `src/utilities/oauth-userinfo.ts`. Complexity 60 + level-4 nesting gone; only the 8 auth guards remain.
- [x] **D2** `functions/oauth/token.ts` — grant flows → `handleAuthorizationCodeGrant` / `handleRefreshTokenGrant` (+ private `ensureFloatingSeat`, `mintTokens`) in a **new** `src/utilities/oauth-token-grants.ts`. Complexity 81 gone; controller is now preamble + dispatch (8 guards).
- [x] **Tier D gate** — `tsc` strict clean; 565/565 green; `npm run format` ✔; smells: high-complexity fns 35→33, high-total 9→7, deeply-nested 3→2, **no new findings**.

## Tier D — controller decomposition (done)

Added after the maintainer refined the rule: controller complexity is worth removing when
the handler holds **extractable logic** (not just guards). Both OAuth outliers qualified.
No endpoint-level tests exist for these two handlers yet (accepted for now — to be added
later); the safety net is that the extracted logic moved into the `src/utilities/*` layer
and the full `src/` suite + `tsc` stay green.

- **`userinfo.ts`** — the scope-gated claim builders + the 4-deep entitlements nest moved
  into `oauth-userinfo.ts` as `buildUserInfoClaims`, with `resolveEntitlementsClaim`
  (guard-returns flatten the nest) and `readEmailClaims` (fail-soft). Handler keeps token
  validation + user lookup, then one `buildUserInfoClaims` call.
- **`token.ts`** — split the two ~60-line grant branches into `handleAuthorizationCodeGrant`
  / `handleRefreshTokenGrant`. **Placement note:** these first went into `oauth-token.ts`,
  but that pushed *its* file-total complexity to 61 (a new smell) — relocating a smell, not
  removing it. So grant orchestration lives in a **new `oauth-token-grants.ts`**, leaving
  `oauth-token.ts` as token primitives. The grant-branch divergences are preserved as
  explicit parameters, per the spec table:
  - floating-seat denial: `ensureFloatingSeat(..., releaseOnFailure)` — `false` for code, `true` for refresh.
  - `nonce`: from the grant on code exchange, `null` on refresh (OIDC §12.1).
  - refresh token: conditional-on-`offline_access` + tolerated on code; always-rotate + hard-500 on refresh.
- **Left in place:** `oauth-token.ts`'s pre-existing `buildIdToken` (complexity 33, two
  level-4 nests) — predates this work and out of scope. It now overlaps conceptually with
  `buildUserInfoClaims`, but unifying ID-token vs UserInfo claim sets is a semantic decision
  (they may legitimately diverge), deliberately not taken here.

## Out of scope

- Anything in [What we are NOT touching](#what-we-are-not-touching-and-why): controller /
  model complexity & many-returns, test duplication, `enable`/`disable`, `webauthn.js`,
  complex binary expressions.
- Tuning `.qlty/qlty.toml` thresholds to mute the inherent-idiom findings. Considered;
  rejected for now — smells aren't a CI gate, so the dashboard noise is harmless, and a
  blanket threshold bump would also hide *future* genuinely-bad complexity. Revisit only
  if the dashboard signal-to-noise becomes a real nuisance.
- ~~The optional `oauth/token.ts` / `userinfo.ts` controller decomposition~~ — **now done**, see [Tier D](#tier-d--controller-decomposition-done).
- Unifying `buildIdToken` (ID-token claims) with `buildUserInfoClaims` (UserInfo claims) —
  conceptually similar, but a deliberate non-merge (the two claim sets may diverge).
