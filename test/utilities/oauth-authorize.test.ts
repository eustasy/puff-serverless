import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "../helpers/fake-db.js"
import { fakeContext } from "../helpers/fake-context.js"
import { fakeEnv } from "../helpers/fake-env.js"
import type { ParsedRequest } from "../../src/utilities/oauth-authorize.js"

// Pure helpers run for real (oauth/headers/next); the four DB-touching siblings
// are mocked so the orchestration branches can be driven directly.
const mocks = vi.hoisted(() => ({
  readAppByClientId: vi.fn(),
  createAuthorizationCode: vi.fn(),
  verifyTokenAndGetUser: vi.fn(),
  isUserInOrg: vi.fn(),
  isLicensed: vi.fn(),
  findEligibleOrgs: vi.fn(),
}))
vi.mock("../../src/apps.js", () => ({ readAppByClientId: mocks.readAppByClientId }))
vi.mock("../../src/oauth-grants.js", () => ({ createAuthorizationCode: mocks.createAuthorizationCode }))
vi.mock("../../src/sessions.js", () => ({ verifyTokenAndGetUser: mocks.verifyTokenAndGetUser }))
vi.mock("../../src/entitlements.js", () => ({
  isUserInOrg: mocks.isUserInOrg,
  isLicensed: mocks.isLicensed,
  findEligibleOrgs: mocks.findEligibleOrgs,
}))

const A = await import("../../src/utilities/oauth-authorize.js")

const appRow = (over: Partial<AppRow> = {}): AppRow =>
  ({
    app_uuid: "a1",
    app_name: "Demo App",
    client_id: "c1",
    client_secret: "s",
    redirect_uris: ["https://app/cb"],
    app_active: true,
    app_licensing_mode: "seat",
    app_default_trial_days: null,
    app_created_at: new Date(0),
    ...over,
  }) as AppRow

const params = (over: Partial<ParsedRequest> = {}): ParsedRequest => ({
  response_type: "code",
  client_id: "c1",
  redirect_uri: "https://app/cb",
  scope: "openid",
  state: "st",
  code_challenge: "cc",
  code_challenge_method: "S256",
  nonce: null,
  org_uuid: null,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("readParams", () => {
  it("extracts present params and defaults the missing ones to empty strings", () => {
    const parsed = A.readParams(new URLSearchParams({ client_id: "c1", scope: "openid profile", state: "st" }))
    expect(parsed).toMatchObject({ client_id: "c1", scope: "openid profile", state: "st", response_type: "", code_challenge: "" })
    expect(parsed.nonce).toBeNull()
  })
})

describe("pure response builders", () => {
  it("renderAuthorizeErrorPage escapes the message and defaults to 400", async () => {
    const response = A.renderAuthorizeErrorPage("<bad>")
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("&lt;bad&gt;")
  })

  it("redirectToClient sets Location and no-store", () => {
    const response = A.redirectToClient("https://app/cb?code=x")
    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("https://app/cb?code=x")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })

  it("redirectToLogin sends to /login with a next cookie", () => {
    const response = A.redirectToLogin(fakeEnv(), "https://app.example/oauth/authorize?client_id=c1")
    expect(response.headers.get("Location")).toBe("/login")
    expect(response.headers.get("Set-Cookie")).toBeTruthy()
  })
})

describe("buildConsentPage", () => {
  it("lists scope descriptions and echoes params as hidden inputs without an org picker", async () => {
    const body = await A.buildConsentPage({ appName: "Demo App", scopes: ["openid", "profile"], params: params() }).text()
    expect(body).toContain("Authorize Demo App")
    expect(body).toContain("Sign you in")
    expect(body).toContain("See your name")
    expect(body).toContain('name="org_uuid"')
    expect(body).not.toContain("Use this app on behalf of")
  })

  it("labels an unrecognised scope", async () => {
    const body = await A.buildConsentPage({ appName: "X", scopes: ["puff:roles"], params: params() }).text()
    expect(body).toContain("(unrecognised scope)")
  })

  it("renders an org picker and drops the hidden org_uuid when several orgs are eligible", async () => {
    const body = await A.buildConsentPage({
      appName: "X",
      scopes: ["openid"],
      params: params(),
      orgs: [
        { org_uuid: "o1", org_name: "Org One" },
        { org_uuid: "o2", org_name: "Org Two" },
      ],
    }).text()
    expect(body).toContain("Use this app on behalf of")
    expect(body).toContain('type="radio" name="org_uuid" value="o1"')
    expect(body).toContain("Org Two")
    expect(body).not.toContain('type="hidden" name="org_uuid"')
  })
})

describe("validateRequest", () => {
  const run = (p: ParsedRequest) => A.validateRequest(new FakeDb().client, p)
  const runStatus = async (p: ParsedRequest) => ((await run(p)) as Response).status
  const locationError = async (response: Response | object) =>
    new URL((response as Response).headers.get("Location")!).searchParams.get("error")

  it("rejects a missing client_id before any lookup", async () => {
    const response = await run(params({ client_id: "" }))
    expect((response as Response).status).toBe(400)
    expect(mocks.readAppByClientId).not.toHaveBeenCalled()
  })

  it("500s on a DB error and 400s on an unknown client", async () => {
    mocks.readAppByClientId.mockResolvedValueOnce({ error: true, message: "db" })
    expect(await runStatus(params())).toBe(500)
    mocks.readAppByClientId.mockResolvedValueOnce({ success: false, message: "no app" })
    expect(await runStatus(params())).toBe(400)
  })

  it("rejects a missing or unregistered redirect_uri", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: true, app: appRow() })
    expect(await runStatus(params({ redirect_uri: "" }))).toBe(400)
    expect(await runStatus(params({ redirect_uri: "https://evil/cb" }))).toBe(400)
  })

  it("redirects unsupported response_type, missing PKCE, and unsupported scopes to the client", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: true, app: appRow() })
    expect(await locationError(await run(params({ response_type: "token" })))).toBe("unsupported_response_type")
    expect(await locationError(await run(params({ code_challenge_method: "plain" })))).toBe("invalid_request")
    expect(await locationError(await run(params({ scope: "openid bogus" })))).toBe("invalid_scope")
  })

  it("returns the app and supported scopes on success", async () => {
    mocks.readAppByClientId.mockResolvedValue({ success: true, app: appRow() })
    const result = await run(params({ scope: "openid profile" }))
    expect(result).toMatchObject({ scopes: ["openid", "profile"] })
    expect((result as { app: AppRow }).app.app_uuid).toBe("a1")
  })
})

describe("authenticatedUserId", () => {
  const ctx = (cookie?: string, withDb = true) =>
    fakeContext({
      request: new Request("https://app.example/oauth/authorize", { headers: cookie ? { Cookie: cookie } : {} }),
      data: { dbClient: withDb ? new FakeDb().client : undefined },
    })

  it("returns null without a session cookie or without a dbClient", async () => {
    expect(await A.authenticatedUserId(ctx())).toBeNull()
    expect(await A.authenticatedUserId(ctx("session_token=tok", false))).toBeNull()
  })

  it("returns the user_uuid for a valid session and null for an invalid one", async () => {
    mocks.verifyTokenAndGetUser.mockResolvedValueOnce({ success: true, user_uuid: "u1" })
    expect(await A.authenticatedUserId(ctx("session_token=tok"))).toBe("u1")
    mocks.verifyTokenAndGetUser.mockResolvedValueOnce({ success: false, message: "bad" })
    expect(await A.authenticatedUserId(ctx("session_token=tok"))).toBeNull()
  })
})

describe("resolveOrgContext", () => {
  const run = (app: AppRow, p: ParsedRequest, user = "u1") => A.resolveOrgContext(new FakeDb().client, app, user, p)

  it("needs no org for a none-mode app", async () => {
    expect(await run(appRow({ app_licensing_mode: "none" }), params())).toEqual({ kind: "no_org_needed", org_uuid: null })
  })

  it("denies an explicit org the user is not a member of", async () => {
    mocks.isUserInOrg.mockResolvedValue({ success: true, member: false })
    const result = await run(appRow(), params({ org_uuid: "o1" }))
    expect(result.kind).toBe("error")
  })

  it("denies an explicit org with no entitlement for non-floating apps", async () => {
    mocks.isUserInOrg.mockResolvedValue({ success: true, member: true })
    mocks.isLicensed.mockResolvedValue({ success: true, licensed: false })
    expect((await run(appRow({ app_licensing_mode: "seat" }), params({ org_uuid: "o1" }))).kind).toBe("error")
  })

  it("binds an explicit licensed org", async () => {
    mocks.isUserInOrg.mockResolvedValue({ success: true, member: true })
    mocks.isLicensed.mockResolvedValue({ success: true, licensed: true })
    expect(await run(appRow(), params({ org_uuid: "o1" }))).toEqual({ kind: "bound", org_uuid: "o1" })
  })

  it("binds an explicit org for a floating app without a license check", async () => {
    mocks.isUserInOrg.mockResolvedValue({ success: true, member: true })
    expect(await run(appRow({ app_licensing_mode: "floating" }), params({ org_uuid: "o1" }))).toEqual({ kind: "bound", org_uuid: "o1" })
    expect(mocks.isLicensed).not.toHaveBeenCalled()
  })

  it("maps the eligible-org count to error / bound / pick", async () => {
    mocks.findEligibleOrgs.mockResolvedValueOnce({ success: false, message: "boom" })
    expect((await run(appRow(), params())).kind).toBe("error")

    mocks.findEligibleOrgs.mockResolvedValueOnce({ success: true, orgs: [] })
    expect((await run(appRow(), params())).kind).toBe("error")

    mocks.findEligibleOrgs.mockResolvedValueOnce({ success: true, orgs: [{ org_uuid: "o1", org_name: "One" }] })
    expect(await run(appRow(), params())).toEqual({ kind: "bound", org_uuid: "o1" })

    mocks.findEligibleOrgs.mockResolvedValueOnce({
      success: true,
      orgs: [
        { org_uuid: "o1", org_name: "One" },
        { org_uuid: "o2", org_name: "Two" },
      ],
    })
    const pick = await run(appRow(), params())
    expect(pick.kind).toBe("pick")
  })
})

describe("issueCodeAndRedirect", () => {
  const opts = (over = {}) => ({
    dbClient: new FakeDb().client,
    user_uuid: "u1",
    app: appRow(),
    scopes: ["openid"],
    params: params(),
    org_uuid: null,
    ...over,
  })

  it("redirects to the client with code and state on success", async () => {
    mocks.createAuthorizationCode.mockResolvedValue({ success: true, code: "the-code" })
    const url = new URL((await A.issueCodeAndRedirect(opts())).headers.get("Location")!)
    expect(url.searchParams.get("code")).toBe("the-code")
    expect(url.searchParams.get("state")).toBe("st")
  })

  it("redirects with server_error when the code cannot be issued", async () => {
    mocks.createAuthorizationCode.mockResolvedValue({ error: true, message: "db" })
    const url = new URL((await A.issueCodeAndRedirect(opts())).headers.get("Location")!)
    expect(url.searchParams.get("error")).toBe("server_error")
  })
})
