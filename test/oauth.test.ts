import { describe, it, expect } from "vitest"
import {
  claimsForScopes,
  oauthErrorResponse,
  oauthRedirectErrorUrl,
  parseScope,
  SUPPORTED_SCOPES,
  validateScopes,
  verifyPkce,
} from "../src/oauth.js"

describe("parseScope", () => {
  it("splits on any whitespace and de-duplicates", () => {
    expect(parseScope("openid profile  email\topenid")).toEqual(["openid", "profile", "email"])
  })

  it("returns an empty array for null/empty input", () => {
    expect(parseScope(null)).toEqual([])
    expect(parseScope("")).toEqual([])
    expect(parseScope("   ")).toEqual([])
  })
})

describe("validateScopes", () => {
  it("splits known from unknown scopes", () => {
    const r = validateScopes(["openid", "profile", "bogus"])
    expect(r.supported).toEqual(["openid", "profile"])
    expect(r.unsupported).toEqual(["bogus"])
  })

  it("recognises every SUPPORTED_SCOPES entry", () => {
    const r = validateScopes([...SUPPORTED_SCOPES])
    expect(r.unsupported).toEqual([])
  })
})

describe("verifyPkce (S256)", () => {
  it("accepts the RFC 7636 §4.6 reference vector", async () => {
    // Reference values from the RFC: the verifier produces the challenge below.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(await verifyPkce(verifier, challenge, "S256")).toBe(true)
  })

  it("rejects a mismatched challenge", async () => {
    expect(await verifyPkce("a".repeat(43), "wrong-challenge", "S256")).toBe(false)
  })

  it("rejects unsupported methods (plain is forbidden in OAuth 2.1)", async () => {
    expect(await verifyPkce("a".repeat(43), "anything", "plain")).toBe(false)
    expect(await verifyPkce("a".repeat(43), "anything", "")).toBe(false)
  })

  it("rejects verifiers outside the 43–128 char range", async () => {
    expect(await verifyPkce("short", "x", "S256")).toBe(false)
    expect(await verifyPkce("a".repeat(129), "x", "S256")).toBe(false)
  })

  it("rejects verifiers containing reserved characters", async () => {
    const bad = "a".repeat(42) + "/"
    expect(await verifyPkce(bad, "x", "S256")).toBe(false)
  })
})

describe("oauthErrorResponse", () => {
  it("emits { error, error_description } JSON with Cache-Control no-store", async () => {
    const r = oauthErrorResponse("invalid_grant", "reason here")
    expect(r.status).toBe(400)
    expect(r.headers.get("Content-Type")).toBe("application/json")
    expect(r.headers.get("Cache-Control")).toBe("no-store")
    const body = await r.json()
    expect(body).toEqual({
      error: "invalid_grant",
      error_description: "reason here",
    })
  })

  it("merges extra headers (e.g. WWW-Authenticate)", () => {
    const r = oauthErrorResponse("invalid_client", undefined, 401, {
      "WWW-Authenticate": 'Basic realm="oauth"',
    })
    expect(r.status).toBe(401)
    expect(r.headers.get("WWW-Authenticate")).toBe('Basic realm="oauth"')
  })
})

describe("oauthRedirectErrorUrl", () => {
  it("appends error + state to the redirect_uri's query string", () => {
    const url = oauthRedirectErrorUrl("https://app.example/cb", "access_denied", "s-1", "user said no")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("error")).toBe("access_denied")
    expect(parsed.searchParams.get("error_description")).toBe("user said no")
    expect(parsed.searchParams.get("state")).toBe("s-1")
  })

  it("preserves existing query params on the redirect_uri", () => {
    const url = oauthRedirectErrorUrl("https://app.example/cb?return=1", "server_error")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("return")).toBe("1")
    expect(parsed.searchParams.get("error")).toBe("server_error")
  })

  it("omits state when none was provided", () => {
    const parsed = new URL(oauthRedirectErrorUrl("https://app.example/cb", "invalid_request"))
    expect(parsed.searchParams.has("state")).toBe(false)
  })
})

describe("claimsForScopes", () => {
  it("toggles every flag based on scope membership", () => {
    expect(claimsForScopes(["openid"])).toEqual({
      includeProfile: false,
      includeEmail: false,
      includeMemberships: false,
      includeRoles: false,
      includeEntitlements: false,
    })
    expect(claimsForScopes(["openid", "profile"])).toMatchObject({
      includeProfile: true,
      includeEmail: false,
    })
    expect(claimsForScopes(["openid", "email"])).toMatchObject({
      includeProfile: false,
      includeEmail: true,
    })
    expect(claimsForScopes(["openid", "puff:memberships", "puff:roles", "puff:entitlements"])).toMatchObject({
      includeMemberships: true,
      includeRoles: true,
      includeEntitlements: true,
    })
  })
})
