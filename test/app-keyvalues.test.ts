import { describe, it, expect } from "vitest"
import {
  deleteKeyValue,
  readKeyValue,
  readKeyValues,
  searchKeyValues,
  setKeyValue,
} from "../src/app-keyvalues.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const appOwner = { type: "app" as const, app_uuid: "a-1" }
const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("app-keyvalues readKeyValue", () => {
  it("rejects an empty key with 400 before any query", async () => {
    const db = new FakeDb()
    expect(await readKeyValue(db.client, "a-1", appOwner, "")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(0)
  })

  it("returns the value when the row exists", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM app_key_values/, {
      rows: [{ kv_value: "default" }],
    })
    const result = await readKeyValue(db.client, "a-1", appOwner, "theme")
    expect(result).toEqual({ success: true, value: "default", status: 200 })
    // The query filters by owner_app_uuid since the owner is an app.
    expect(db.calls[0]!.text).toMatch(/owner_app_uuid = \$2/)
    expect(db.calls[0]!.values).toEqual(["a-1", "a-1", "theme"])
  })

  it("returns 404 when no row matches", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM app_key_values/, { rows: [] })
    expect((await readKeyValue(db.client, "a-1", appOwner, "k")).status).toBe(
      404
    )
  })

  it("returns 500 on DB error", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM app_key_values/, pgError("08006"))
    expect((await readKeyValue(db.client, "a-1", appOwner, "k")).status).toBe(
      500
    )
  })
})

describe("app-keyvalues readKeyValues", () => {
  it("returns the owner's rows for the app subject", async () => {
    const db = new FakeDb()
    const rows = [
      {
        app_uuid: "a-1",
        kv_key: "theme",
        kv_value: "default",
        owner_user_uuid: null,
        owner_org_uuid: null,
        owner_app_uuid: "a-1",
        owner_id: "a-1",
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]
    db.on(/SELECT[\s\S]*FROM app_key_values/, { rows })
    const result = await readKeyValues(db.client, "a-1", appOwner)
    expect(result.success).toBe(true)
    if (result.success) expect(result.pairs).toEqual(rows)
  })
})

describe("app-keyvalues searchKeyValues", () => {
  it("escapes LIKE wildcards in the pattern", async () => {
    const db = new FakeDb()
    db.on(/SELECT[\s\S]*FROM app_key_values[\s\S]*LIKE/, { rows: [] })
    await searchKeyValues(db.client, "a-1", appOwner, "100%off_now")
    const search = db.calls[0]!
    // Both wildcards must be escaped.
    expect(search.values[2]).toBe("%100\\%off\\_now%")
  })

  it("rejects an empty pattern with 400", async () => {
    const db = new FakeDb()
    expect(
      (await searchKeyValues(db.client, "a-1", appOwner, "  ")).status
    ).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe("app-keyvalues setKeyValue", () => {
  it("inserts a new row with the owner_app slot populated", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO app_key_values/, { rowCount: 1 })
    const result = await setKeyValue(
      db.client,
      "a-1",
      appOwner,
      "theme",
      "default"
    )
    expect(result).toMatchObject({ success: true, created: true, status: 201 })
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    // Subject (app_uuid), key, value, owner_user, owner_org, owner_app.
    expect(insert.values).toEqual([
      "a-1",
      "theme",
      "default",
      null,
      null,
      "a-1",
    ])
  })

  it("allows an org to set a per-app entitlement row", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_key_values/, { rows: [] })
    db.on(/SELECT count/, { rows: [{ count: 0 }] })
    db.on(/INSERT INTO app_key_values/, { rowCount: 1 })
    await setKeyValue(db.client, "a-1", orgOwner, "perm:export", "granted")
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    expect(insert.values).toEqual([
      "a-1",
      "perm:export",
      "granted",
      null,
      "org-1",
      null,
    ])
  })
})

describe("app-keyvalues deleteKeyValue", () => {
  it("returns 404 when no row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM app_key_values/, { rowCount: 0 })
    expect((await deleteKeyValue(db.client, "a-1", appOwner, "k")).status).toBe(
      404
    )
  })

  it("returns 200 when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM app_key_values/, { rowCount: 1 })
    expect((await deleteKeyValue(db.client, "a-1", appOwner, "k")).status).toBe(
      200
    )
  })
})
