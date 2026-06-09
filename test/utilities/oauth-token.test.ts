import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "../helpers/fake-db.js"
import { fakeEnv } from "../helpers/fake-env.js"

// buildIdToken / buildAccessToken compose JWT signing + user/email/claim reads.
// We mock the heavy siblings and the signer (capturing its payload) so the test
// asserts the assembled claim set, not the crypto — which has its own tests.
const mocks = vi.hoisted(() => ({
  signJwt: vi.fn(),
  readUser: vi.fn(),
  readEmails: vi.fn(),
  buildMembershipsClaim: vi.fn(),
  buildRolesClaim: vi.fn(),
  buildEntitlementsClaim: vi.fn(),
}))
vi.mock("../../src/oauth-jwt.js", () => ({ signJwt: mocks.signJwt }))
vi.mock("../../src/users.js", () => ({ readUser: mocks.readUser }))
vi.mock("../../src/emails.js", () => ({ readEmails: mocks.readEmails }))
vi.mock("../../src/oauth-claims.js", () => ({
  buildMembershipsClaim: mocks.buildMembershipsClaim,
  buildRolesClaim: mocks.buildRolesClaim,
  buildEntitlementsClaim: mocks.buildEntitlementsClaim,
}))

const { parseBasicAuth, tokenResponse, buildAccessToken, buildIdToken, ACCESS_TOKEN_TTL_SECONDS } = await import(
  "../../src/utilities/oauth-token.js"
)

const app = { app_uuid: "a1", app_licensing_mode: "seat" as const }
const signedPayload = () => mocks.signJwt.mock.calls[0]![1] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.signJwt.mockResolvedValue("signed.jwt.token")
})

describe("parseBasicAuth", () => {
  it("decodes a well-formed Basic header and URL-decodes both halves", () => {
    const header = "Basic " + btoa("a%40b:p%20w")
    expect(parseBasicAuth(header)).toEqual({ client_id: "a@b", client_secret: "p w" })
  })

  it("returns null for a missing, non-Basic, colon-less, or undecodable header", () => {
    expect(parseBasicAuth(null)).toBeNull()
    expect(parseBasicAuth("Bearer xyz")).toBeNull()
    expect(parseBasicAuth("Basic " + btoa("nocolon"))).toBeNull()
    expect(parseBasicAuth("Basic !!!not-base64!!!")).toBeNull()
  })
})

describe("tokenResponse", () => {
  it("serialises the body as JSON with no-store cache headers", async () => {
    const response = tokenResponse({ access_token: "at", token_type: "Bearer", expires_in: 3600, scope: "openid" })
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("application/json")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Pragma")).toBe("no-cache")
    expect(await response.json()).toMatchObject({ access_token: "at", token_type: "Bearer" })
  })
})

describe("buildAccessToken", () => {
  it("signs a payload with scope, a jti, and a one-hour expiry", async () => {
    const token = await buildAccessToken(fakeEnv(), {
      user_uuid: "u1",
      client_id: "c1",
      issuer: "https://issuer",
      scopes: ["openid", "profile"],
      org_uuid: null,
    })
    expect(token).toBe("signed.jwt.token")
    const payload = signedPayload()
    expect(payload).toMatchObject({ iss: "https://issuer", sub: "u1", aud: "c1", client_id: "c1", scope: "openid profile" })
    expect(payload.exp).toBe((payload.iat as number) + ACCESS_TOKEN_TTL_SECONDS)
    expect(typeof payload.jti).toBe("string")
    expect(payload).not.toHaveProperty("org_uuid")
  })

  it("includes org_uuid when the grant is org-bound", async () => {
    await buildAccessToken(fakeEnv(), { user_uuid: "u1", client_id: "c1", issuer: "i", scopes: ["openid"], org_uuid: "o1" })
    expect(signedPayload().org_uuid).toBe("o1")
  })
})

describe("buildIdToken", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    user_uuid: "u1",
    client_id: "c1",
    issuer: "https://issuer",
    scopes: ["openid"] as string[],
    nonce: null as string | null,
    app,
    org_uuid: null as string | null,
    ...over,
  })

  it("returns null when openid is not requested", async () => {
    const result = await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["profile"] }))
    expect(result).toBeNull()
    expect(mocks.signJwt).not.toHaveBeenCalled()
  })

  it("signs a minimal token with no profile/email reads for bare openid", async () => {
    const result = await buildIdToken(fakeEnv(), new FakeDb().client, ctx())
    expect(result).toBe("signed.jwt.token")
    expect(mocks.readUser).not.toHaveBeenCalled()
    expect(signedPayload()).toMatchObject({ iss: "https://issuer", sub: "u1", aud: "c1" })
  })

  it("adds the name claim for the profile scope", async () => {
    mocks.readUser.mockResolvedValue({ success: true, user: { user_name: "Ada" }, status: 200 })
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "profile"] }))
    expect(signedPayload().name).toBe("Ada")
  })

  it("adds the verified primary email for the email scope", async () => {
    mocks.readUser.mockResolvedValue({ success: true, user: { user_name: "Ada" }, status: 200 })
    mocks.readEmails.mockResolvedValue([
      { email_address: "secondary@example.com", is_primary: false, is_verified: true },
      { email_address: "primary@example.com", is_primary: true, is_verified: true },
    ])
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "email"] }))
    expect(signedPayload()).toMatchObject({ email: "primary@example.com", email_verified: true })
  })

  it("skips name/email claims when the user read fails", async () => {
    mocks.readUser.mockResolvedValue({ success: false, message: "gone", status: 404 })
    const result = await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "profile", "email"] }))
    expect(result).toBe("signed.jwt.token")
    const payload = signedPayload()
    expect(payload).not.toHaveProperty("name")
    expect(payload).not.toHaveProperty("email")
    expect(mocks.readEmails).not.toHaveBeenCalled()
  })

  it("falls back to any verified email when none is marked primary", async () => {
    mocks.readUser.mockResolvedValue({ success: true, user: { user_name: "Ada" }, status: 200 })
    mocks.readEmails.mockResolvedValue([{ email_address: "verified@example.com", is_primary: false, is_verified: true }])
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "email"] }))
    expect(signedPayload()).toMatchObject({ email: "verified@example.com", email_verified: true })
  })

  it("omits puff:memberships and puff:roles when those builders fail", async () => {
    mocks.buildMembershipsClaim.mockResolvedValue({ success: false, message: "x", status: 500 })
    mocks.buildRolesClaim.mockResolvedValue({ success: false, message: "x", status: 500 })
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "puff:memberships", "puff:roles"] }))
    const payload = signedPayload()
    expect(payload).not.toHaveProperty("puff:memberships")
    expect(payload).not.toHaveProperty("puff:roles")
  })

  it("tolerates an email read failure without failing the token", async () => {
    mocks.readUser.mockResolvedValue({ success: true, user: { user_name: "Ada" }, status: 200 })
    mocks.readEmails.mockRejectedValue(new Error("db down"))
    const result = await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "email"] }))
    expect(result).toBe("signed.jwt.token")
    expect(signedPayload()).not.toHaveProperty("email")
  })

  it("carries nonce and org_uuid through when present", async () => {
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ nonce: "n1", org_uuid: "o1" }))
    expect(signedPayload()).toMatchObject({ nonce: "n1", org_uuid: "o1" })
  })

  it("adds puff:* claims for the puff scopes when the builders succeed", async () => {
    mocks.buildMembershipsClaim.mockResolvedValue({ success: true, memberships: [{ org_uuid: "o1", org_name: "O" }], status: 200 })
    mocks.buildRolesClaim.mockResolvedValue({ success: true, roles: [{ org_uuid: "o1" }], status: 200 })
    mocks.buildEntitlementsClaim.mockResolvedValue({ success: true, entitlements: { tier: "pro" }, status: 200 })
    await buildIdToken(
      fakeEnv(),
      new FakeDb().client,
      ctx({ scopes: ["openid", "puff:memberships", "puff:roles", "puff:entitlements"], org_uuid: "o1" })
    )
    const payload = signedPayload()
    expect(payload["puff:memberships"]).toEqual([{ org_uuid: "o1", org_name: "O" }])
    expect(payload["puff:roles"]).toEqual([{ org_uuid: "o1" }])
    expect(payload["puff:entitlements"]).toEqual({ tier: "pro" })
  })

  it("omits puff:entitlements when the claim resolves to null", async () => {
    mocks.buildEntitlementsClaim.mockResolvedValue({ success: true, entitlements: null, status: 200 })
    await buildIdToken(fakeEnv(), new FakeDb().client, ctx({ scopes: ["openid", "puff:entitlements"] }))
    expect(signedPayload()).not.toHaveProperty("puff:entitlements")
  })
})
