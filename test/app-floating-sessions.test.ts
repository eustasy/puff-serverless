import { describe, it, expect } from "vitest"
import {
  checkoutFloatingSeat,
  countActiveFloatingSeats,
  getFloatingPoolMax,
  heartbeatFloatingSeat,
  reapStaleFloatingSessions,
  releaseFloatingSeat,
} from "../src/app-floating-sessions.js"
import { FakeDb } from "./helpers/fake-db.js"

describe("getFloatingPoolMax", () => {
  it("returns the per-org override when set", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_key_values/, {
      rows: [{ kv_value: "50" }],
    })
    const result = await getFloatingPoolMax(db.client, "a-1", "o-1")
    expect(result).toEqual({ success: true, max: 50, status: 200 })
  })

  it("falls back to the app-level default when no org override exists", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_key_values/, { rows: [] })
    db.on(/FROM app_key_values/, { rows: [{ kv_value: "10" }] })
    const result = await getFloatingPoolMax(db.client, "a-1", "o-1")
    expect(result).toEqual({ success: true, max: 10, status: 200 })
  })

  it("returns null when no pool is configured anywhere", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_key_values/, { rows: [] })
    db.on(/FROM app_key_values/, { rows: [] })
    const result = await getFloatingPoolMax(db.client, "a-1", "o-1")
    expect(result).toEqual({ success: true, max: null, status: 200 })
  })

  it("treats a non-integer pool value as missing", async () => {
    const db = new FakeDb()
    db.on(/FROM organisation_key_values/, {
      rows: [{ kv_value: "not-a-number" }],
    })
    db.on(/FROM app_key_values/, { rows: [] })
    const result = await getFloatingPoolMax(db.client, "a-1", "o-1")
    expect(result).toEqual({ success: true, max: null, status: 200 })
  })
})

describe("checkoutFloatingSeat", () => {
  it("bumps the heartbeat on an existing seat without a pool check", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_floating_sessions/, {
      rows: [{ ok: 1 }],
      rowCount: 1,
    })
    db.on(/INSERT INTO app_floating_sessions/, {
      rows: [{ expires_at: new Date("2030-01-01") }],
    })
    const result = await checkoutFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.allocated).toBe("existing")
    // Pool size should NOT have been queried — existing seats bypass the gate.
    expect(
      db.calls.some((c) => /FROM organisation_key_values/.test(c.text))
    ).toBe(false)
  })

  it("checks pool size and inserts a new row when free slots remain", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_floating_sessions/, { rows: [], rowCount: 0 })
    db.on(/FROM organisation_key_values/, { rows: [{ kv_value: "3" }] })
    db.on(/count\(\*\)::INT AS count[\s\S]*FROM app_floating_sessions/, {
      rows: [{ count: 1 }],
    })
    db.on(/INSERT INTO app_floating_sessions/, {
      rows: [{ expires_at: new Date("2030-01-01") }],
    })
    const result = await checkoutFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.allocated).toBe("new")
  })

  it("refuses a new allocation when no pool is configured", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_floating_sessions/, { rows: [], rowCount: 0 })
    db.on(/FROM organisation_key_values/, { rows: [] })
    db.on(/FROM app_key_values/, { rows: [] })
    const result = await checkoutFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result.success).toBe(false)
    if (!result.success && !result.error) expect(result.status).toBe(409)
  })

  it("refuses when the pool is fully allocated", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM app_floating_sessions/, { rows: [], rowCount: 0 })
    db.on(/FROM organisation_key_values/, { rows: [{ kv_value: "2" }] })
    db.on(/count\(\*\)::INT AS count[\s\S]*FROM app_floating_sessions/, {
      rows: [{ count: 2 }],
    })
    const result = await checkoutFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result.success).toBe(false)
    if (!result.success && !result.error) expect(result.status).toBe(409)
  })
})

describe("heartbeatFloatingSeat", () => {
  it("reports existing: false when no row matches", async () => {
    const db = new FakeDb()
    db.on(/UPDATE app_floating_sessions/, { rows: [], rowCount: 0 })
    const result = await heartbeatFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result).toEqual({ success: true, existing: false, status: 200 })
  })

  it("reports existing: true when a row was updated", async () => {
    const db = new FakeDb()
    db.on(/UPDATE app_floating_sessions/, { rows: [], rowCount: 1 })
    const result = await heartbeatFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result).toEqual({ success: true, existing: true, status: 200 })
  })
})

describe("releaseFloatingSeat", () => {
  it("returns released: true when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM app_floating_sessions/, { rows: [], rowCount: 1 })
    const result = await releaseFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result).toEqual({ success: true, released: true, status: 200 })
  })

  it("is idempotent — released: false when nothing matched", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM app_floating_sessions/, { rows: [], rowCount: 0 })
    const result = await releaseFloatingSeat(db.client, "a-1", "o-1", "u-1")
    expect(result).toEqual({ success: true, released: false, status: 200 })
  })
})

describe("countActiveFloatingSeats", () => {
  it("returns the count from the DB", async () => {
    const db = new FakeDb()
    db.on(/count\(\*\)::INT AS count/, { rows: [{ count: 7 }] })
    const result = await countActiveFloatingSeats(db.client, "a-1", "o-1")
    expect(result).toEqual({ success: true, count: 7, status: 200 })
  })
})

describe("reapStaleFloatingSessions", () => {
  it("reports how many expired rows were deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM app_floating_sessions/, { rows: [], rowCount: 4 })
    const result = await reapStaleFloatingSessions(db.client)
    expect(result).toEqual({ success: true, reaped: 4, status: 200 })
  })
})
