import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "../helpers/fake-db.js"
import type { JwtPayload } from "../../src/oauth-jwt.js"

const mocks = vi.hoisted(() => ({
  readEmails: vi.fn(),
  readAppByClientId: vi.fn(),
  buildEntitlementsClaim: vi.fn(),
  buildMembershipsClaim: vi.fn(),
  buildRolesClaim: vi.fn(),
}))
vi.mock("../../src/emails.js", () => ({ readEmails: mocks.readEmails }))
vi.mock("../../src/apps.js", () => ({ readAppByClientId: mocks.readAppByClientId }))
vi.mock("../../src/oauth-claims.js", () => ({
  buildEntitlementsClaim: mocks.buildEntitlementsClaim,
  buildMembershipsClaim: mocks.buildMembershipsClaim,
  buildRolesClaim: mocks.buildRolesClaim,
}))

const { bearerError, buildUserInfoClaims } = await import("../../src/utilities/oauth-userinfo.js")

const user = { user_uuid: "u1", user_name: "Ada" } as UserRow
const payload = (over: Record<string, unknown> = {}): JwtPayload => ({ scope: "openid", ...over }) as JwtPayload
const build = (p: JwtPayload) => buildUserInfoClaims(new FakeDb().client, user, p)

beforeEach(() => vi.clearAllMocks())

describe("bearerError", () => {
  it("returns a 401 invalid_token with a Bearer challenge by default", () => {
    const response = bearerError("invalid_token", "The token expired")
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toContain('Bearer error="invalid_token"')
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("supports insufficient_scope with a custom status and quote-sanitised description", () => {
    const response = bearerError("insufficient_scope", 'needs "email"', 403)
    expect(response.status).toBe(403)
    expect(response.headers.get("WWW-Authenticate")).toContain("needs 'email'")
  })
})

describe("buildUserInfoClaims", () => {
  it("returns only sub for the bare openid scope", async () => {
    expect(await build(payload())).toEqual({ sub: "u1" })
  })

  it("adds name for the profile scope", async () => {
    expect(await build(payload({ scope: "openid profile" }))).toMatchObject({ name: "Ada" })
  })

  it("adds the verified primary email for the email scope", async () => {
    mocks.readEmails.mockResolvedValue([
      { email_address: "second@example.com", is_primary: false, is_verified: true },
      { email_address: "primary@example.com", is_primary: true, is_verified: true },
    ])
    expect(await build(payload({ scope: "openid email" }))).toMatchObject({ email: "primary@example.com", email_verified: true })
  })

  it("omits email when there is no verified address", async () => {
    mocks.readEmails.mockResolvedValue([{ email_address: "x@example.com", is_primary: true, is_verified: false }])
    expect(await build(payload({ scope: "openid email" }))).toEqual({ sub: "u1" })
  })

  it("fails soft when the email read throws", async () => {
    mocks.readEmails.mockRejectedValue(new Error("db down"))
    expect(await build(payload({ scope: "openid email" }))).toEqual({ sub: "u1" })
  })

  it("adds puff:memberships and puff:roles when their builders succeed", async () => {
    mocks.buildMembershipsClaim.mockResolvedValue({ success: true, memberships: [{ org_uuid: "o1" }], status: 200 })
    mocks.buildRolesClaim.mockResolvedValue({ success: true, roles: [{ org_uuid: "o1" }], status: 200 })
    const claims = await build(payload({ scope: "openid puff:memberships puff:roles" }))
    expect(claims["puff:memberships"]).toEqual([{ org_uuid: "o1" }])
    expect(claims["puff:roles"]).toEqual([{ org_uuid: "o1" }])
  })

  it("omits puff:roles when its builder fails", async () => {
    mocks.buildRolesClaim.mockResolvedValue({ success: false, message: "x", status: 500 })
    expect(await build(payload({ scope: "openid puff:roles" }))).toEqual({ sub: "u1" })
  })

  it("omits puff:memberships when its builder fails", async () => {
    mocks.buildMembershipsClaim.mockResolvedValue({ success: false, message: "x", status: 500 })
    expect(await build(payload({ scope: "openid puff:memberships" }))).toEqual({ sub: "u1" })
  })

  it("treats a non-string scope claim as no scopes", async () => {
    expect(await build(payload({ scope: 1234 }))).toEqual({ sub: "u1" })
  })

  it("omits puff:entitlements when the app resolves but has no entitlements", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: true, app: { app_uuid: "a1", app_licensing_mode: "seat" }, status: 200 })
    mocks.buildEntitlementsClaim.mockResolvedValue({ success: true, entitlements: null, status: 200 })
    const claims = await build(payload({ scope: "openid puff:entitlements", client_id: "c1", org_uuid: "o1" }))
    expect(claims).toEqual({ sub: "u1" })
  })

  it("resolves puff:entitlements from the token's app + org context", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: true, app: { app_uuid: "a1", app_licensing_mode: "seat" }, status: 200 })
    mocks.buildEntitlementsClaim.mockResolvedValue({ success: true, entitlements: { tier: "pro" }, status: 200 })
    const claims = await build(payload({ scope: "openid puff:entitlements", client_id: "c1", org_uuid: "o1" }))
    expect(claims["puff:entitlements"]).toEqual({ tier: "pro" })
  })

  it("omits puff:entitlements when the token has no app/org context", async () => {
    expect(await build(payload({ scope: "openid puff:entitlements" }))).toEqual({ sub: "u1" })
    expect(mocks.readAppByClientId).not.toHaveBeenCalled()
  })

  it("omits puff:entitlements when the app cannot be resolved", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: false, message: "gone", status: 404 })
    const claims = await build(payload({ scope: "openid puff:entitlements", client_id: "c1", org_uuid: "o1" }))
    expect(claims).toEqual({ sub: "u1" })
  })
})
