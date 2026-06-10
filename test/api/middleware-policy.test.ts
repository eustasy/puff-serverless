import { describe, it, expect } from "vitest"
import { policyFor, type Policy } from "../../functions/api/_middleware.js"

// Exact paths that need neither DB nor a session (today's functions/api/*.ts).
const NO_DB_PATHS = ["/api/csp-report", "/api/messages", "/api/password-requirements", "/api/providers"]

// Exact paths that need the DB but no session (functions/api/* leaves
// registered in PUBLIC_DB).
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

  it("returns DB-only, external CORS for the billing webhook (static path)", () => {
    expect(policyFor("/api/billing/webhook")).toEqual<Policy>({ db: true, auth: false, operator: false, cors: "external" })
  })

  it("returns DB-only, external CORS for the dynamic billing usage path (prefix rule catches dynamic segment)", () => {
    expect(policyFor("/api/billing/usage/3f9c1a2b-4d5e-6f7a-8b9c-0d1e2f3a4b5c")).toEqual<Policy>({
      db: true,
      auth: false,
      operator: false,
      cors: "external",
    })
  })
})
