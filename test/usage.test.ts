import { describe, it, expect, vi } from "vitest"
import { recordUsageEvent, recomputeUsageRollups, syncUsageRollups, listUsageRollups } from "../src/usage.js"
import type { BillingProvider } from "../src/billing.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

function fakeProvider(over: Partial<BillingProvider> = {}): BillingProvider {
  return {
    name: "stripe",
    createCustomer: vi.fn(),
    createSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    createCheckoutSession: vi.fn(),
    createBillingPortalSession: vi.fn(),
    updateCustomer: vi.fn(async () => {}),
    recordMeterEvent: vi.fn(async () => {}),
    verifyWebhookSignature: vi.fn(async () => true),
    ...over,
  } as unknown as BillingProvider
}

// ---------------------------------------------------------------------------
// recordUsageEvent
// ---------------------------------------------------------------------------

const baseInput = {
  app_uuid: "app-1",
  org_uuid: "org-1",
  user_uuid: "user-1",
  metric: "api_calls",
  quantity: 5,
  occurred_at: new Date("2025-06-01T12:00:00Z"),
  idempotency_key: "idem-abc123",
}

describe("recordUsageEvent", () => {
  it("inserts a row and returns success with a new event_uuid", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_events/, {
      rows: [{ event_uuid: "generated-uuid" }],
      rowCount: 1,
    })

    const result = await recordUsageEvent(db.client, baseInput)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(result.event_uuid).toBe("generated-uuid")
    expect(result.status).toBe(201)

    // Verify the query was parameterized correctly.
    expect(db.calls).toHaveLength(1)
    const { text, values } = db.calls[0]
    expect(text).toContain("INSERT INTO usage_events")
    expect(text).toContain("ON CONFLICT (app_uuid, idempotency_key) DO NOTHING")
    expect(values).toContain("app-1")
    expect(values).toContain("org-1")
    expect(values).toContain("user-1")
    expect(values).toContain("api_calls")
    expect(values).toContain(5)
    expect(values).toContain("idem-abc123")
  })

  it("returns success (not an error) when the idempotency_key already exists", async () => {
    // ON CONFLICT DO NOTHING → rowCount 0; the duplicate path then looks up
    // the existing event's uuid.
    const db = new FakeDb()
    db.on(/INSERT INTO usage_events/, { rows: [], rowCount: 0 })
    db.on(/SELECT event_uuid FROM usage_events/, {
      rows: [{ event_uuid: "existing-uuid" }],
    })

    const result = await recordUsageEvent(db.client, baseInput)
    expect(result.success).toBe(true)
    // Status 200 signals "already landed", not 201.
    expect(result.status).toBe(200)
    if (result.success) expect(result.event_uuid).toBe("existing-uuid")
  })

  it("accepts a null user_uuid and passes NULL to the database", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_events/, {
      rows: [{ event_uuid: "e1" }],
      rowCount: 1,
    })

    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      user_uuid: null,
    })
    expect(result.success).toBe(true)

    const nullValue = db.calls[0].values.find((v) => v === null)
    expect(nullValue).toBeNull()
  })

  it("accepts an ISO string for occurred_at", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_events/, {
      rows: [{ event_uuid: "e2" }],
      rowCount: 1,
    })

    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      occurred_at: "2025-06-01T12:00:00Z",
    })
    expect(result.success).toBe(true)
  })

  it("rejects a negative quantity", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      quantity: -1,
    })
    expect(result.success).toBe(false)
    if (result.success !== false || result.error) throw new Error()
    expect(result.status).toBe(400)
    expect(result.message).toMatch(/quantity/)
    expect(db.calls).toHaveLength(0)
  })

  it("rejects a non-finite quantity (NaN)", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      quantity: NaN,
    })
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("rejects a non-finite quantity (Infinity)", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      quantity: Infinity,
    })
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an empty metric string", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      metric: "",
    })
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(result).toHaveProperty("message")
    expect(db.calls).toHaveLength(0)
  })

  it("rejects a whitespace-only metric string", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      metric: "   ",
    })
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an invalid occurred_at string", async () => {
    const db = new FakeDb()
    const result = await recordUsageEvent(db.client, {
      ...baseInput,
      occurred_at: "not-a-date",
    })
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("returns a 500 error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_events/, pgError("08006"))

    const result = await recordUsageEvent(db.client, baseInput)
    expect(result.error).toBe(true)
    expect(result.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// recomputeUsageRollups
// ---------------------------------------------------------------------------

describe("recomputeUsageRollups", () => {
  it("issues the aggregate/upsert SQL with the correct day parameter", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_rollups/, { rows: [], rowCount: 3 })

    const result = await recomputeUsageRollups(db.client, "2025-06-01")
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(result.upserted).toBe(3)
    expect(result.status).toBe(200)

    expect(db.calls).toHaveLength(1)
    const { text, values } = db.calls[0]
    expect(text).toContain("INSERT INTO usage_rollups")
    expect(text).toContain("SUM(quantity)")
    expect(text).toContain("ON CONFLICT (app_uuid, org_uuid, metric, day) DO UPDATE")
    expect(text).toContain("synced_at")
    // Day value is passed as a parameter.
    expect(values[0]).toBe("2025-06-01")
  })

  it("accepts a Date object and normalises it to a UTC date string", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_rollups/, { rowCount: 0 })

    const result = await recomputeUsageRollups(db.client, new Date("2025-06-15T00:00:00Z"))
    expect(result.success).toBe(true)
    expect(db.calls[0].values[0]).toBe("2025-06-15")
  })

  it("accepts an ISO datetime string and uses only the date part", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_rollups/, { rowCount: 0 })

    const result = await recomputeUsageRollups(db.client, "2025-06-15T23:59:59Z")
    expect(result.success).toBe(true)
    expect(db.calls[0].values[0]).toBe("2025-06-15")
  })

  it("returns 0 upserted when there are no events for that day", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_rollups/, { rows: [], rowCount: 0 })

    const result = await recomputeUsageRollups(db.client, "2025-01-01")
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(result.upserted).toBe(0)
  })

  it("returns a 500 error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO usage_rollups/, pgError("08006"))

    const result = await recomputeUsageRollups(db.client, "2025-06-01")
    expect(result.error).toBe(true)
    expect(result.status).toBe(500)
  })

  it("rejects a malformed day string", async () => {
    const db = new FakeDb()
    const result = await recomputeUsageRollups(db.client, "not-a-date")
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an invalid Date object", async () => {
    const db = new FakeDb()
    const result = await recomputeUsageRollups(db.client, new Date("invalid"))
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// syncUsageRollups
// ---------------------------------------------------------------------------

describe("syncUsageRollups", () => {
  it("pushes each unsynced rollup and marks it synced", async () => {
    const db = new FakeDb()
    db.on(/FROM usage_rollups r\s+JOIN billing_customers/, {
      rows: [
        {
          app_uuid: "app-1",
          org_uuid: "org-1",
          metric: "api_calls",
          day: new Date("2025-06-01T00:00:00Z"),
          quantity: "42",
          provider_customer_id: "cus_1",
        },
      ],
    })
    db.on(/UPDATE usage_rollups SET synced_at/, { rowCount: 1 })
    const provider = fakeProvider()

    const result = await syncUsageRollups(db.client, provider)
    expect(result).toMatchObject({ success: true, synced: 1, status: 200 })
    expect(provider.recordMeterEvent).toHaveBeenCalledWith({
      eventName: "api_calls",
      customerId: "cus_1",
      value: 42,
      identifier: "app-1:org-1:api_calls:2025-06-01",
    })
  })

  it("leaves a rollup unsynced when the provider push fails", async () => {
    const db = new FakeDb()
    db.on(/FROM usage_rollups r\s+JOIN billing_customers/, {
      rows: [
        {
          app_uuid: "app-1",
          org_uuid: "org-1",
          metric: "api_calls",
          day: new Date("2025-06-01T00:00:00Z"),
          quantity: "42",
          provider_customer_id: "cus_1",
        },
      ],
    })
    const provider = fakeProvider({
      recordMeterEvent: vi.fn(async () => {
        throw new Error("stripe down")
      }),
    })

    const result = await syncUsageRollups(db.client, provider)
    expect(result).toMatchObject({ success: true, synced: 0 })
    // No UPDATE should have run for the failed row.
    expect(db.calls.some((c) => /UPDATE usage_rollups SET synced_at/.test(c.text))).toBe(false)
  })

  it("returns synced 0 when there is nothing to push", async () => {
    const db = new FakeDb()
    db.on(/FROM usage_rollups r\s+JOIN billing_customers/, { rows: [] })
    const result = await syncUsageRollups(db.client, fakeProvider())
    expect(result).toMatchObject({ success: true, synced: 0 })
  })
})

describe("listUsageRollups", () => {
  it("lists all rollups when no org filter is given", async () => {
    const db = new FakeDb()
    db.on(/FROM usage_rollups\s+ORDER BY day DESC/, {
      rows: [
        {
          app_uuid: "app-1",
          org_uuid: "org-1",
          metric: "api_calls",
          day: new Date("2025-06-01T00:00:00Z"),
          quantity: "10",
          synced_at: null,
        },
      ],
    })
    const result = await listUsageRollups(db.client)
    expect(result).toMatchObject({ success: true, status: 200 })
    if (result.success) expect(result.rollups).toHaveLength(1)
  })

  it("filters by org when org_uuid is given", async () => {
    const db = new FakeDb()
    db.on(/FROM usage_rollups WHERE org_uuid = \$1/, { rows: [] })
    const result = await listUsageRollups(db.client, { org_uuid: "org-9" })
    expect(result).toMatchObject({ success: true })
    expect(db.calls[0]?.values?.[0]).toBe("org-9")
  })
})
