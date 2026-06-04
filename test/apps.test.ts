import { describe, it, expect } from "vitest"
import { hashClientSecret, listApps, readApp, readAppByClientId, verifyAppCredentials } from "../src/apps.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const sampleApp: AppRow = {
  app_uuid: "a-1",
  app_name: "Sample",
  client_id: "cid-1",
  client_secret: "stored:salt",
  redirect_uris: ["https://app.example/cb"],
  app_active: true,
  app_licensing_mode: "none",
  app_default_trial_days: null,
  app_created_at: new Date("2026-05-01T00:00:00Z"),
}

describe("readApp", () => {
  it("returns the active app row", async () => {
    const db = new FakeDb()
    db.on(/FROM apps[\s\S]*app_uuid = \$1/, { rows: [sampleApp] })
    const result = await readApp(db.client, "a-1")
    expect(result).toEqual({ success: true, app: sampleApp, status: 200 })
    expect(db.calls[0]!.values).toEqual(["a-1"])
  })

  it("returns 404 when the app is missing or inactive", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, { rows: [] })
    const result = await readApp(db.client, "a-x")
    expect(result.success).toBe(false)
    expect(result.status).toBe(404)
  })

  it("returns 500 on DB error", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, pgError("08006"))
    expect((await readApp(db.client, "a-1")).status).toBe(500)
  })
})

describe("readAppByClientId", () => {
  it("returns the active app row matched by client_id", async () => {
    const db = new FakeDb()
    db.on(/FROM apps[\s\S]*client_id = \$1/, { rows: [sampleApp] })
    const result = await readAppByClientId(db.client, "cid-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.app.app_uuid).toBe("a-1")
  })

  it("returns 404 when no row matches", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, { rows: [] })
    expect((await readAppByClientId(db.client, "x")).status).toBe(404)
  })
})

describe("verifyAppCredentials", () => {
  it("verifies a candidate against the stored hash:salt", async () => {
    const db = new FakeDb()
    const { stored } = await hashClientSecret("hunter2")
    db.on(/FROM apps/, {
      rows: [{ ...sampleApp, client_secret: stored }],
    })
    const result = await verifyAppCredentials(db.client, "cid-1", "hunter2")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.verified).toBe(true)
      expect(result.app?.app_uuid).toBe("a-1")
    }
  })

  it("rejects a wrong secret without returning the app row", async () => {
    const db = new FakeDb()
    const { stored } = await hashClientSecret("hunter2")
    db.on(/FROM apps/, {
      rows: [{ ...sampleApp, client_secret: stored }],
    })
    const result = await verifyAppCredentials(db.client, "cid-1", "wrong")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.verified).toBe(false)
      expect(result.app).toBeNull()
    }
  })

  it("returns verified=false when the app is unknown", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, { rows: [] })
    const result = await verifyAppCredentials(db.client, "cid-?", "anything")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.verified).toBe(false)
      expect(result.app).toBeNull()
    }
  })

  it("returns verified=false for a malformed stored value (no colon)", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, {
      rows: [{ ...sampleApp, client_secret: "not-formatted" }],
    })
    const result = await verifyAppCredentials(db.client, "cid-1", "anything")
    expect(result.success).toBe(true)
    if (result.success) expect(result.verified).toBe(false)
  })
})

describe("listApps", () => {
  it("returns all apps in creation order", async () => {
    const db = new FakeDb()
    db.on(/FROM apps[\s\S]*ORDER BY app_created_at DESC/, {
      rows: [sampleApp, { ...sampleApp, app_uuid: "a-2" }],
    })
    const result = await listApps(db.client)
    expect(result.success).toBe(true)
    if (result.success) expect(result.apps).toHaveLength(2)
  })
})

describe("hashClientSecret", () => {
  it("produces a hash:salt string round-trippable by verifyAppCredentials", async () => {
    const { stored } = await hashClientSecret("a-very-long-secret-here")
    expect(stored.split(":").length).toBe(2)
    const [hash, salt] = stored.split(":")
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(salt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
