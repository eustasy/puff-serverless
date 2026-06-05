import { describe, it, expect } from "vitest"
import {
  assertGranteeInOrg,
  findEligibleOrgs,
  isLicensed,
  isTeamInOrg,
  isUserInOrg,
  listEntitlementsForToken,
  summariseLicensing,
} from "../src/entitlements.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("isUserInOrg / isTeamInOrg", () => {
  it("isUserInOrg returns true when a row exists", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_members/, { rows: [{ x: 1 }], rowCount: 1 })
    const r = await isUserInOrg(db.client, "o-1", "u-1")
    expect(r).toEqual({ success: true, member: true, status: 200 })
  })

  it("isTeamInOrg returns false when the team does not belong", async () => {
    const db = new FakeDb()
    db.on(/FROM teams WHERE team_uuid/, { rows: [], rowCount: 0 })
    const r = await isTeamInOrg(db.client, "o-1", "t-1")
    expect(r).toEqual({ success: true, belongs: false, status: 200 })
  })

  it("returns 500 when the existence query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_members/, pgError("08006"))
    expect((await isUserInOrg(db.client, "o-1", "u-1")).status).toBe(500)
  })
})

describe("assertGranteeInOrg", () => {
  it("404s a non-member user grantee", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_members/, { rows: [], rowCount: 0 })
    const r = await assertGranteeInOrg(db.client, "o-1", {
      type: "user",
      user_uuid: "u-1",
    })
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(404)
  })

  it("passes a team grantee that belongs", async () => {
    const db = new FakeDb()
    db.on(/FROM teams WHERE team_uuid/, { rows: [{ x: 1 }], rowCount: 1 })
    const r = await assertGranteeInOrg(db.client, "o-1", {
      type: "team",
      team_uuid: "t-1",
    })
    expect(r.success).toBe(true)
  })

  it("passes a user grantee that is a member", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_members/, { rows: [{ x: 1 }], rowCount: 1 })
    const r = await assertGranteeInOrg(db.client, "o-1", { type: "user", user_uuid: "u-1" })
    expect(r).toMatchObject({ success: true, status: 200 })
  })

  it("404s a team grantee that does not belong", async () => {
    const db = new FakeDb()
    db.on(/FROM teams WHERE team_uuid/, { rows: [], rowCount: 0 })
    const r = await assertGranteeInOrg(db.client, "o-1", { type: "team", team_uuid: "t-1" })
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(404)
  })

  it("propagates a DB error from the user membership check", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_members/, pgError("08006"))
    expect(await assertGranteeInOrg(db.client, "o-1", { type: "user", user_uuid: "u-1" })).toMatchObject({ error: true, status: 500 })
  })

  it("propagates a DB error from the team membership check", async () => {
    const db = new FakeDb()
    db.on(/FROM teams WHERE team_uuid/, pgError("08006"))
    expect(await assertGranteeInOrg(db.client, "o-1", { type: "team", team_uuid: "t-1" })).toMatchObject({ error: true, status: 500 })
  })
})

describe("isLicensed", () => {
  it("'none' is always licensed", async () => {
    const db = new FakeDb()
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "none" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: true, tier: null })
    expect(db.calls).toHaveLength(0)
  })

  it("a billed mode is unlicensed when the org has no subscription", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [], rowCount: 0 })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: false, tier: null })
  })

  it("a billed mode is unlicensed when the subscription is past_due", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, {
      rows: [{ status: "past_due" }],
      rowCount: 1,
    })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "usage" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: false, tier: null })
  })

  it("'usage' is licensed iff user is in org (with active sub)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM organisation_members/, { rows: [{ x: 1 }], rowCount: 1 })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "usage" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: true, tier: null })
  })

  it("'seat' is licensed when license:tier resolves (with trialing sub)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "trialing" }], rowCount: 1 })
    db.on(/FROM user_key_values/, {
      rows: [{ kv_value: "pro" }],
      rowCount: 1,
    })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: true, tier: "pro" })
  })

  it("'seat' is unlicensed when no tier resolves at any level", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM user_key_values/, { rows: [], rowCount: 0 })
    db.on(/FROM org_role_key_values/, { rows: [], rowCount: 0 })
    db.on(/FROM organisation_key_values/, { rows: [], rowCount: 0 })
    db.on(/FROM app_key_values/, { rows: [], rowCount: 0 })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: false, tier: null })
  })

  it("'floating' is licensed iff an active session row exists (with active sub)", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM app_floating_sessions/, { rows: [{ x: 1 }], rowCount: 1 })
    const r = await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "floating" }, "u-1", "o-1")
    expect(r).toMatchObject({ success: true, licensed: true, tier: null })
  })

  it("propagates a subscription-lookup DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, pgError("08006"))
    expect(await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")).toMatchObject({ error: true })
  })

  it("propagates a membership DB error in usage mode", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM organisation_members/, pgError("08006"))
    expect(await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "usage" }, "u-1", "o-1")).toMatchObject({ error: true })
  })

  it("propagates a resolver DB error in seat mode", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM user_key_values/, pgError("08006")) // resolveKeyValue → error envelope
    expect(await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")).toMatchObject({ error: true })
  })

  it("returns 500 when the floating-session query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM subscriptions/, { rows: [{ status: "active" }], rowCount: 1 })
    db.on(/FROM app_floating_sessions/, pgError("08006"))
    expect((await isLicensed(db.client, { app_uuid: "a-1", app_licensing_mode: "floating" }, "u-1", "o-1")).status).toBe(500)
  })
})

describe("summariseLicensing", () => {
  it("'none' reports zero", async () => {
    const db = new FakeDb()
    const r = await summariseLicensing(db.client, { app_uuid: "a-1", app_licensing_mode: "none" }, "o-1")
    expect(r).toMatchObject({ success: true, mode: "none", assigned: 0 })
  })

  it("'floating' returns active + max", async () => {
    const db = new FakeDb()
    db.on(/count\(\*\)::INT AS count[\s\S]*FROM app_floating_sessions/, {
      rows: [{ count: 3 }],
    })
    db.on(/FROM organisation_key_values/, { rows: [{ kv_value: "10" }] })
    const r = await summariseLicensing(db.client, { app_uuid: "a-1", app_licensing_mode: "floating" }, "o-1")
    expect(r).toMatchObject({
      success: true,
      mode: "floating",
      active: 3,
      max: 10,
    })
  })

  it("'seat' counts distinct users with a license:tier row", async () => {
    const db = new FakeDb()
    db.on(/count\(DISTINCT user_uuid\)::INT AS count/, {
      rows: [{ count: 12 }],
    })
    const r = await summariseLicensing(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "o-1")
    expect(r).toMatchObject({ success: true, mode: "seat", assigned: 12 })
  })

  it("'usage' counts distinct users with any app-owned KV row", async () => {
    const db = new FakeDb()
    db.on(/count\(DISTINCT user_uuid\)::INT AS count/, { rows: [{ count: 5 }] })
    const r = await summariseLicensing(db.client, { app_uuid: "a-1", app_licensing_mode: "usage" }, "o-1")
    expect(r).toMatchObject({ success: true, mode: "usage", assigned: 5 })
  })

  it("returns 500 when a count query throws", async () => {
    const db = new FakeDb()
    db.on(/count\(DISTINCT user_uuid\)::INT AS count/, pgError("08006"))
    expect((await summariseLicensing(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "o-1")).status).toBe(500)
  })
})

describe("listEntitlementsForToken", () => {
  it("emits the declared perms when they resolve, omits the rest", async () => {
    const db = new FakeDb()
    // listAppPermissions
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND owner_app_uuid = \$1/, {
      rows: [
        { kv_key: "license:perms:export", kv_value: "Export" },
        { kv_key: "license:perms:admin", kv_value: "Admin" },
      ],
    })
    // Each perm runs through the resolver — first walks user, then role tiers
    // etc. We script just the user-tier matches: "export" → granted, "admin"
    // → no hit.
    db.on(/SELECT kv_value FROM user_key_values WHERE user_uuid = \$1 AND owner_app_uuid = \$2 AND kv_key = \$3 LIMIT 1/, (values) => ({
      rows: values[2] === "perm:export" ? [{ kv_value: "granted" }] : [],
    }))
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND/, { rows: [] })

    const r = await listEntitlementsForToken(db.client, { app_uuid: "a-1", app_licensing_mode: "none" }, "u-1", "o-1")
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.claim.perms).toEqual({ export: "granted" })
      expect(r.claim.tier).toBeNull()
    }
  })

  it("resolves the seat tier for a seat-mode app", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND owner_app_uuid = \$1/, {
      rows: [{ kv_key: "license:perms:export", kv_value: "Export" }],
    })
    // The user-tier resolver answers both the perm key and the license:tier key.
    db.on(/SELECT kv_value FROM user_key_values WHERE user_uuid = \$1 AND owner_app_uuid = \$2 AND kv_key = \$3 LIMIT 1/, (values) => ({
      rows: values[2] === "perm:export" ? [{ kv_value: "granted" }] : values[2] === "license:tier" ? [{ kv_value: "pro" }] : [],
    }))
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    const r = await listEntitlementsForToken(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.claim.tier).toBe("pro")
      expect(r.claim.perms).toEqual({ export: "granted" })
    }
  })

  it("propagates a listAppPermissions DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND owner_app_uuid = \$1/, pgError("08006"))
    expect(await listEntitlementsForToken(db.client, { app_uuid: "a-1", app_licensing_mode: "none" }, "u-1", "o-1")).toMatchObject({
      error: true,
    })
  })

  it("propagates a resolver error while building perms", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND owner_app_uuid = \$1/, {
      rows: [{ kv_key: "license:perms:export", kv_value: "Export" }],
    })
    db.on(/SELECT kv_value FROM user_key_values WHERE user_uuid = \$1 AND owner_app_uuid = \$2 AND kv_key = \$3 LIMIT 1/, pgError("08006"))
    expect(await listEntitlementsForToken(db.client, { app_uuid: "a-1", app_licensing_mode: "none" }, "u-1", "o-1")).toMatchObject({
      error: true,
    })
  })

  it("propagates a resolver error while reading the seat tier", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values WHERE app_uuid = \$1 AND owner_app_uuid = \$1/, { rows: [] }) // no declared perms
    db.on(/SELECT kv_value FROM user_key_values WHERE user_uuid = \$1 AND owner_app_uuid = \$2 AND kv_key = \$3 LIMIT 1/, pgError("08006")) // tier resolver throws
    expect(await listEntitlementsForToken(db.client, { app_uuid: "a-1", app_licensing_mode: "seat" }, "u-1", "o-1")).toMatchObject({
      error: true,
    })
  })
})

describe("findEligibleOrgs", () => {
  it("returns the rows from the eligibility query", async () => {
    const db = new FakeDb()
    db.on(/FROM organisations o[\s\S]*JOIN organisation_members/, {
      rows: [
        { org_uuid: "o-1", org_name: "Acme" },
        { org_uuid: "o-2", org_name: "Beta" },
      ],
    })
    const r = await findEligibleOrgs(db.client, "a-1", "u-1")
    expect(r.success).toBe(true)
    if (r.success) expect(r.orgs).toHaveLength(2)
  })

  it("returns 500 when the eligibility query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM organisations o[\s\S]*JOIN organisation_members/, pgError("08006"))
    expect((await findEligibleOrgs(db.client, "a-1", "u-1")).status).toBe(500)
  })
})
