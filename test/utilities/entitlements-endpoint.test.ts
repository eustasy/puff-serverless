import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "../helpers/fake-db.js"
import { fakeContext } from "../helpers/fake-context.js"

// The entitlement endpoints compose real `can()` + form parsing + the KV
// methods passed via config. Only the two DB/hook leaf calls are mocked:
// `assertGranteeInOrg` (grantee-in-org check) and `emitFromContext` (audit).
const mocks = vi.hoisted(() => ({
  assertGranteeInOrg: vi.fn(),
  emitFromContext: vi.fn(),
}))
vi.mock("../../src/entitlements.js", () => ({ assertGranteeInOrg: mocks.assertGranteeInOrg }))
vi.mock("../../src/hooks/dispatch.js", () => ({ emitFromContext: mocks.emitFromContext }))

const {
  validateEntitlementKey,
  createGranteeEntitlementListHandler,
  createGranteeEntitlementSetHandler,
  createGranteeEntitlementRemoveHandler,
} = await import("../../src/utilities/entitlements-endpoint.js")

const app = { app_uuid: "app-1" } as AppRow

const ctx = (over: { orgRoles?: string[]; request?: Request; params?: Record<string, string> } = {}) =>
  fakeContext({
    data: { dbClient: new FakeDb().client, orgRoles: over.orgRoles ?? ["owner"], app },
    params: { org_uuid: "o1", team_uuid: "t1", ...over.params },
    request: over.request,
  })

const formRequest = (fields: Record<string, string>): Request =>
  new Request("https://app.example/x", { method: "POST", body: new URLSearchParams(fields) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.assertGranteeInOrg.mockResolvedValue({ success: true, status: 200 })
  mocks.emitFromContext.mockResolvedValue(undefined)
})

describe("validateEntitlementKey", () => {
  it("accepts the tier key and any perm:* key", () => {
    expect(validateEntitlementKey("license:tier")).toBeNull()
    expect(validateEntitlementKey("perm:export")).toBeNull()
  })

  it("rejects the bare perm prefix and unrelated keys", async () => {
    const rejected = validateEntitlementKey("perm:")
    const other = validateEntitlementKey("license:floating:max")
    expect(rejected).toBeInstanceOf(Response)
    expect((rejected as Response).status).toBe(400)
    expect(other).toBeInstanceOf(Response)
  })
})

describe("createGranteeEntitlementListHandler", () => {
  const kv = { readKeyValues: vi.fn(), searchKeyValues: vi.fn() }
  const handler = createGranteeEntitlementListHandler({ kv, paramName: "team_uuid", granteeType: "team", urlSegment: "teams" })

  beforeEach(() => {
    kv.readKeyValues.mockReset().mockResolvedValue({ success: true, pairs: [{ kv_key: "license:tier", kv_value: "pro" }], status: 200 })
    kv.searchKeyValues.mockReset().mockResolvedValue({ success: true, pairs: [], status: 200 })
  })

  it("403s when the caller lacks read permission", async () => {
    const response = await handler.onRequestGet(ctx({ orgRoles: ["member"] }))
    expect(response.status).toBe(403)
  })

  it("renders the table from readKeyValues, scoped to the app owner", async () => {
    const response = await handler.onRequestGet(ctx())
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("license:tier")
    expect(kv.readKeyValues).toHaveBeenCalledWith(expect.anything(), "t1", { type: "app", app_uuid: "app-1" })
  })

  it("uses searchKeyValues when a ?key= filter is present", async () => {
    await handler.onRequestGet(ctx({ request: new Request("https://app.example/x?key=lic") }))
    expect(kv.searchKeyValues).toHaveBeenCalledWith(expect.anything(), "t1", expect.anything(), "lic")
    expect(kv.readKeyValues).not.toHaveBeenCalled()
  })

  it("propagates a grantee-not-in-org failure", async () => {
    mocks.assertGranteeInOrg.mockResolvedValue({ success: false, message: "not a member", status: 404 })
    expect((await handler.onRequestGet(ctx())).status).toBe(404)
  })

  it("surfaces a KV read failure", async () => {
    kv.readKeyValues.mockResolvedValue({ success: false, message: "boom", status: 500 })
    expect((await handler.onRequestGet(ctx())).status).toBe(500)
  })

  it("405s other methods", async () => {
    const response = await handler.onRequest(ctx())
    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("GET")
  })
})

describe("createGranteeEntitlementSetHandler", () => {
  const kv = { setKeyValue: vi.fn() }
  const handler = createGranteeEntitlementSetHandler({
    kv,
    paramName: "team_uuid",
    granteeType: "team",
    eventType: "org.team.entitlements.set",
  })

  beforeEach(() => {
    kv.setKeyValue.mockReset().mockResolvedValue({ success: true, created: true, status: 201 })
  })

  it("403s without write permission", async () => {
    const response = await handler.onRequestPost(ctx({ orgRoles: ["member"], request: formRequest({ key: "license:tier", value: "pro" }) }))
    expect(response.status).toBe(403)
  })

  it("returns the parse error for a non-form body", async () => {
    const bad = new Request("https://app.example/x", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })
    expect((await handler.onRequestPost(ctx({ request: bad }))).status).toBe(400)
  })

  it("rejects a key outside the entitlement namespace", async () => {
    const response = await handler.onRequestPost(ctx({ request: formRequest({ key: "random", value: "x" }) }))
    expect(response.status).toBe(400)
  })

  it("sets the value, emits an event, and triggers a refresh", async () => {
    const response = await handler.onRequestPost(ctx({ request: formRequest({ key: "license:tier", value: "pro" }) }))
    expect(response.status).toBe(201)
    expect(await response.text()).toContain("granted")
    expect(response.headers.get("HX-Trigger")).toBe("appEntitlementsChanged")
    expect(kv.setKeyValue).toHaveBeenCalledWith(expect.anything(), "t1", { type: "app", app_uuid: "app-1" }, "license:tier", "pro")
    expect(mocks.emitFromContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event_type: "org.team.entitlements.set" })
    )
  })

  it('reports "updated" when the key already existed', async () => {
    kv.setKeyValue.mockResolvedValue({ success: true, created: false, status: 200 })
    expect(await (await handler.onRequestPost(ctx({ request: formRequest({ key: "perm:export", value: "1" }) }))).text()).toContain(
      "updated"
    )
  })

  it("surfaces a set failure without emitting an event", async () => {
    kv.setKeyValue.mockResolvedValue({ success: false, message: "boom", status: 500 })
    const response = await handler.onRequestPost(ctx({ request: formRequest({ key: "license:tier", value: "pro" }) }))
    expect(response.status).toBe(500)
    expect(mocks.emitFromContext).not.toHaveBeenCalled()
  })

  it("405s other methods", async () => {
    const response = await handler.onRequest(ctx())
    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("POST")
  })
})

describe("createGranteeEntitlementRemoveHandler", () => {
  const kv = { deleteKeyValue: vi.fn() }
  const handler = createGranteeEntitlementRemoveHandler({
    kv,
    paramName: "user_uuid",
    granteeType: "user",
    eventType: "org.user.entitlements.removed",
  })

  beforeEach(() => {
    kv.deleteKeyValue.mockReset().mockResolvedValue({ success: true, status: 200 })
  })

  it("403s without write permission", async () => {
    const response = await handler.onRequestPost(ctx({ orgRoles: ["member"], request: formRequest({ key: "license:tier" }) }))
    expect(response.status).toBe(403)
  })

  it("revokes the key, emits an event, and triggers a refresh", async () => {
    const response = await handler.onRequestPost(ctx({ params: { user_uuid: "u9" }, request: formRequest({ key: "license:tier" }) }))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("revoked")
    expect(response.headers.get("HX-Trigger")).toBe("appEntitlementsChanged")
    expect(kv.deleteKeyValue).toHaveBeenCalledWith(expect.anything(), "u9", { type: "app", app_uuid: "app-1" }, "license:tier")
    expect(mocks.emitFromContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event_type: "org.user.entitlements.removed" })
    )
  })

  it("surfaces a delete failure", async () => {
    kv.deleteKeyValue.mockResolvedValue({ success: false, message: "boom", status: 500 })
    expect((await handler.onRequestPost(ctx({ request: formRequest({ key: "license:tier" }) }))).status).toBe(500)
  })

  it("405s other methods", async () => {
    expect((await handler.onRequest(ctx())).status).toBe(405)
  })
})
