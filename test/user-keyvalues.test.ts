import { describe, it, expect } from "vitest"
import {
  readKeyValue,
  readKeyValues,
  searchKeyValues,
  setKeyValue,
  deleteKeyValue,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  MAX_KEYS_PER_OWNER_SUBJECT,
} from "../src/user-keyvalues.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

const userOwner = { type: "user" as const, user_uuid: "u-1" }
const orgOwner = { type: "org" as const, org_uuid: "org-1" }

describe("user-keyvalues readKeyValue", () => {
  it("rejects an empty key with 400 before any query", async () => {
    const db = new FakeDb()
    expect(
      await readKeyValue(db.client, "u-target", userOwner, "  ")
    ).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("rejects a key over the length limit with 400", async () => {
    const db = new FakeDb()
    const tooLong = "x".repeat(MAX_KEY_LENGTH + 1)
    expect(
      (await readKeyValue(db.client, "u-target", userOwner, tooLong)).status
    ).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("returns the value when the row exists", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM user_key_values/, {
      rows: [{ kv_value: "v1" }],
    })
    expect(
      await readKeyValue(db.client, "u-target", userOwner, "theme")
    ).toEqual({ success: true, value: "v1", status: 200 })
    // SELECT bound to (user_uuid, owner_user_uuid, key)
    expect(db.calls[0].values).toEqual(["u-target", "u-1", "theme"])
  })

  it("filters by org owner when owner.type === 'org'", async () => {
    const db = new FakeDb()
    db.on(/owner_org_uuid = \$2/, { rows: [{ kv_value: "license-A" }] })
    expect(
      await readKeyValue(db.client, "u-target", orgOwner, "license")
    ).toMatchObject({ success: true, value: "license-A" })
    expect(db.calls[0].values).toEqual(["u-target", "org-1", "license"])
  })

  it("returns 404 when the row is absent", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM user_key_values/, { rows: [] })
    expect(
      (await readKeyValue(db.client, "u-target", userOwner, "theme")).status
    ).toBe(404)
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM user_key_values/, pgError("08006"))
    expect(
      (await readKeyValue(db.client, "u-target", userOwner, "theme")).status
    ).toBe(500)
  })
})

describe("user-keyvalues readKeyValues", () => {
  it("returns the (subject, owner) rows", async () => {
    const db = new FakeDb()
    db.on(/SELECT user_uuid, kv_key, kv_value/, {
      rows: [
        { user_uuid: "u-target", kv_key: "a", kv_value: "1" },
        { user_uuid: "u-target", kv_key: "b", kv_value: "2" },
      ],
    })
    const result = await readKeyValues(db.client, "u-target", userOwner)
    expect(result).toMatchObject({ success: true, status: 200 })
    if (result.success) {
      expect(result.pairs).toHaveLength(2)
    }
  })

  it("returns 500 on query error", async () => {
    const db = new FakeDb()
    db.on(/SELECT user_uuid, kv_key, kv_value/, pgError("XXX"))
    expect((await readKeyValues(db.client, "u-target", userOwner)).status).toBe(
      500
    )
  })
})

describe("user-keyvalues searchKeyValues", () => {
  it("rejects an empty pattern with 400", async () => {
    const db = new FakeDb()
    expect(
      (await searchKeyValues(db.client, "u-target", userOwner, "   ")).status
    ).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it("escapes LIKE wildcards in the pattern", async () => {
    const db = new FakeDb()
    db.on(/SELECT user_uuid, kv_key, kv_value/, { rows: [] })
    await searchKeyValues(db.client, "u-target", userOwner, "50%_off")
    expect(db.calls[0].values[2]).toBe("%50\\%\\_off%")
  })
})

describe("user-keyvalues setKeyValue", () => {
  it("rejects an empty key", async () => {
    const db = new FakeDb()
    expect(
      (await setKeyValue(db.client, "u-target", userOwner, "  ", "v")).status
    ).toBe(400)
  })

  it("rejects an over-long value", async () => {
    const db = new FakeDb()
    const bigValue = "x".repeat(MAX_VALUE_LENGTH + 1)
    expect(
      (await setKeyValue(db.client, "u-target", userOwner, "k", bigValue))
        .status
    ).toBe(400)
  })

  it("upserts a new row (created=true, status 201)", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM user_key_values/, { rows: [] }) // not exists
    db.on(/SELECT count\(\*\)/, { rows: [{ count: 5 }] })
    db.on(/INSERT INTO user_key_values/, { rowCount: 1 })
    const result = await setKeyValue(
      db.client,
      "u-target",
      userOwner,
      "theme",
      "dark"
    )
    expect(result).toMatchObject({ success: true, created: true, status: 201 })
    // INSERT carries the user owner in the right slot and null in the org/app slots.
    const insert = db.calls.find((c) => c.text.startsWith("INSERT"))!
    expect(insert.values).toEqual([
      "u-target",
      "theme",
      "dark",
      "u-1",
      null,
      null,
    ])
  })

  it("upserts an existing row (created=false, status 200)", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM user_key_values/, { rows: [{ "?column?": 1 }] })
    db.on(/INSERT INTO user_key_values/, { rowCount: 1 })
    const result = await setKeyValue(
      db.client,
      "u-target",
      userOwner,
      "theme",
      "dark"
    )
    expect(result).toMatchObject({ success: true, created: false, status: 200 })
  })

  it("rejects creating a new key when the per-owner limit is reached", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM user_key_values/, { rows: [] })
    db.on(/SELECT count\(\*\)/, {
      rows: [{ count: MAX_KEYS_PER_OWNER_SUBJECT }],
    })
    const result = await setKeyValue(db.client, "u-target", userOwner, "k", "v")
    expect(result).toMatchObject({ success: false, status: 409 })
    // No INSERT issued — the rollback ran instead.
    expect(db.calls.some((c) => c.text.startsWith("INSERT"))).toBe(false)
  })

  it("allows update when an existing key would push count past the limit", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM user_key_values/, { rows: [{ "?column?": 1 }] })
    db.on(/INSERT INTO user_key_values/, { rowCount: 1 })
    const result = await setKeyValue(db.client, "u-target", userOwner, "k", "v")
    expect(result).toMatchObject({ success: true, created: false })
    // count(*) is never even queried for updates.
    expect(db.calls.some((c) => /SELECT count/.test(c.text))).toBe(false)
  })
})

describe("user-keyvalues deleteKeyValue", () => {
  it("returns 404 when no row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM user_key_values/, { rowCount: 0 })
    expect(
      (await deleteKeyValue(db.client, "u-target", userOwner, "k")).status
    ).toBe(404)
  })

  it("returns 200 when a row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM user_key_values/, { rowCount: 1 })
    expect(
      (await deleteKeyValue(db.client, "u-target", userOwner, "k")).success
    ).toBe(true)
  })

  it("uses org owner column when owner.type === 'org'", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM user_key_values/, { rowCount: 1 })
    await deleteKeyValue(db.client, "u-target", orgOwner, "k")
    expect(db.calls[0].text).toContain("owner_org_uuid = $2")
    expect(db.calls[0].values).toEqual(["u-target", "org-1", "k"])
  })
})
