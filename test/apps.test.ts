import { describe, it, expect } from "vitest"
import {
  hashClientSecret,
  isAppLicensingMode,
  listApps,
  listAppTiers,
  readApp,
  readAppByClientId,
  verifyAppCredentials,
} from "../src/apps.js"
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

describe("isAppLicensingMode", () => {
  it("accepts every declared licensing mode", () => {
    for (const mode of ["none", "seat", "usage", "floating"]) {
      expect(isAppLicensingMode(mode)).toBe(true)
    }
  })

  it("rejects unknown strings and non-strings", () => {
    expect(isAppLicensingMode("perpetual")).toBe(false)
    expect(isAppLicensingMode(42)).toBe(false)
    expect(isAppLicensingMode(null)).toBe(false)
  })
})

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

  it("propagates a lookup DB error as a 500", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, pgError("08006"))
    expect(await verifyAppCredentials(db.client, "cid-1", "anything")).toMatchObject({ error: true, status: 500 })
  })

  it("returns 500 when the stored secret is not a string", async () => {
    const db = new FakeDb()
    // A malformed row whose client_secret is null makes `.indexOf` throw,
    // exercising the catch.
    db.on(/FROM apps/, { rows: [{ ...sampleApp, client_secret: null }] })
    expect(await verifyAppCredentials(db.client, "cid-1", "anything")).toMatchObject({ error: true, status: 500 })
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

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM apps/, pgError("08006"))
    expect((await listApps(db.client)).status).toBe(500)
  })
})

describe("listAppTiers", () => {
  it("maps the license:tiers: keys to { name, label } entries", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values/, {
      rows: [
        { kv_key: "license:tiers:pro", kv_value: "Pro plan" },
        { kv_key: "license:tiers:free", kv_value: "Free plan" },
      ],
    })
    const result = await listAppTiers(db.client, "a-1")
    expect(result).toEqual({
      success: true,
      tiers: [
        { name: "pro", label: "Pro plan" },
        { name: "free", label: "Free plan" },
      ],
      status: 200,
    })
  })

  it("propagates a DB error from the shared helper", async () => {
    const db = new FakeDb()
    db.on(/FROM app_key_values/, pgError("08006"))
    expect((await listAppTiers(db.client, "a-1")).status).toBe(500)
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
