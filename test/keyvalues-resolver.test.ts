import { describe, it, expect } from "vitest"
import { resolveKeyValue } from "../src/keyvalues-resolver.js"
import { FakeDb } from "./helpers/fake-db.js"

const orgOwner = { type: "org" as const, org_uuid: "org-1" }
const appOwner = { type: "app" as const, app_uuid: "a-1" }

describe("resolveKeyValue", () => {
  it("rejects an empty key with 400 before any query", async () => {
    const db = new FakeDb()
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "  ",
      user_uuid: "u-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("returns the user-tier value first when present", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [{ kv_value: "user-override" }] })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "theme",
      user_uuid: "u-1",
      org_uuid: "org-1",
      team_uuid: "team-1",
    })
    expect(result).toMatchObject({
      success: true,
      values: ["user-override"],
      source: "user",
    })
    // Only the user-tier query ran — later tiers are short-circuited.
    expect(db.calls).toHaveLength(1)
  })

  it("falls through to team-role when user-tier misses", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, {
      rows: [{ kv_value: "from-lead" }],
    })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "quota",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({
      success: true,
      values: ["from-lead"],
      source: "team-role",
    })
  })

  it("merges multiple role values at the team-role tier", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, {
      rows: [{ kv_value: "a" }, { kv_value: "b" }],
    })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "perm",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({
      success: true,
      values: ["a", "b"],
      source: "team-role",
    })
  })

  it("falls through to org-role when user + team-role miss", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, {
      rows: [{ kv_value: "from-admin" }],
    })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "perm",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ success: true, source: "org-role" })
  })

  it("falls through to team when role tiers miss", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [{ kv_value: "team-default" }] })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({
      values: ["team-default"],
      source: "team",
    })
  })

  it("falls through to org last", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, {
      rows: [{ kv_value: "org-default" }],
    })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ values: ["org-default"], source: "org" })
  })

  it("returns empty values + null source when no tier matches", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ success: true, values: [], source: null })
  })

  it("skips team tiers when no team_uuid is given", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, {
      rows: [{ kv_value: "org-val" }],
    })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      org_uuid: "org-1",
      // no team_uuid
    })
    expect(result).toMatchObject({ source: "org", values: ["org-val"] })
    // Confirm no team-tier query ran.
    expect(db.calls.some((c) => /team_(role_)?key_values/.test(c.text))).toBe(false)
  })

  it("skips org tiers when no org_uuid is given", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
    })
    expect(result).toMatchObject({ success: true, values: [], source: null })
    expect(db.calls.some((c) => /org_role_key_values|organisation_key_values/.test(c.text))).toBe(false)
  })

  it("filters every tier by the owner namespace", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    // Every tier query carries org-1 in the owner-bound parameter.
    for (const call of db.calls) {
      expect(call.values).toContain("org-1")
    }
  })

  it("falls through to the app tier when owner is an app and every earlier tier misses", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    db.on(/FROM app_key_values/, { rows: [{ kv_value: "app-default" }] })
    const result = await resolveKeyValue(db.client, {
      owner: appOwner,
      key: "perm:export",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ values: ["app-default"], source: "app" })
    // The app tier filters by both subject = app_uuid AND owner_app_uuid = app_uuid.
    const appCall = db.calls.find((c) => /FROM app_key_values/.test(c.text))!
    expect(appCall.values).toEqual(["a-1", "a-1", "perm:export"])
  })

  it("does NOT query the app tier when owner is not an app", async () => {
    const db = new FakeDb()
    db.on(/FROM user_key_values/, { rows: [] })
    db.on(/FROM team_role_key_values/, { rows: [] })
    db.on(/FROM org_role_key_values/, { rows: [] })
    db.on(/FROM team_key_values/, { rows: [] })
    db.on(/FROM organisation_key_values/, { rows: [] })
    const result = await resolveKeyValue(db.client, {
      owner: orgOwner,
      key: "k",
      user_uuid: "u-1",
      team_uuid: "team-1",
      org_uuid: "org-1",
    })
    expect(result).toMatchObject({ success: true, values: [], source: null })
    expect(db.calls.some((c) => /FROM app_key_values/.test(c.text))).toBe(false)
  })
})
