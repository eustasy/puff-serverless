import { describe, it, expect } from "vitest"
import { policyFor, type Policy } from "../../functions/api/_middleware.js"

// Exact paths that need neither DB nor a session (today's functions/api/*.ts).
const NO_DB_PATHS = ["/api/csp-report", "/api/messages", "/api/password-requirements", "/api/providers"]

// Exact paths that need the DB but no session (today's functions/api/db/*
// non-auth leaves, mapped to their future flat paths).
const PUBLIC_DB_PATHS = [
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
]

describe("policyFor", () => {
  it("returns no-DB, no-auth for every NO_DB path", () => {
    for (const path of NO_DB_PATHS) {
      expect(policyFor(path), path).toEqual<Policy>({ db: false, auth: false, operator: false, cors: "internal" })
    }
  })

  it("returns DB-only (no auth, internal CORS) for every PUBLIC_DB path", () => {
    for (const path of PUBLIC_DB_PATHS) {
      expect(policyFor(path), path).toEqual<Policy>({ db: true, auth: false, operator: false, cors: "internal" })
    }
  })

  it("returns DB + auth + operator for a future admin path", () => {
    expect(policyFor("/api/admin/oauth-keys/rotate")).toEqual<Policy>({ db: true, auth: true, operator: true, cors: "internal" })
  })

  it("falls back to the strict default (DB + auth, no operator) for an unlisted path", () => {
    expect(policyFor("/api/email/list")).toEqual<Policy>({ db: true, auth: true, operator: false, cors: "internal" })
  })

  // TEMP: these two assertions change in stage 4, when the legacy nested tree
  // and the legacy billing middleware are deleted and the TEMP passthrough at
  // the top of policyFor is removed. Until then both prefixes defer to the OLD
  // middleware (no DB, no auth here), so this file does not double-connect.
  it("defers legacy /api/db/** paths to the old middleware (TEMP passthrough)", () => {
    expect(policyFor("/api/db/auth/email/list")).toEqual<Policy>({ db: false, auth: false, operator: false, cors: "internal" })
  })

  it("defers legacy /api/billing/* paths to the old middleware (TEMP passthrough)", () => {
    expect(policyFor("/api/billing/webhook")).toEqual<Policy>({ db: false, auth: false, operator: false, cors: "external" })
  })

  // TODO stage 4: once the TEMP passthrough is removed, the dynamic billing
  // usage path should resolve to the REAL billing policy — DB-only, no session
  // auth, external CORS — which the prefix rule below the passthrough provides.
  // Cannot assert it yet because the passthrough shadows it:
  //   expect(policyFor("/api/billing/usage/<uuid>")).toEqual({ db: true, auth: false, operator: false, cors: "external" })
})
