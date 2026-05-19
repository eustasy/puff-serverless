import { describe, it, expect } from "vitest"
import {
  readKeyValue,
  readKeyValues,
  searchKeyValues,
  setKeyValue,
  deleteKeyValue,
  MAX_KEYS_PER_USER,
  MAX_KEY_LENGTH,
} from "../src/keyvalues.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("readKeyValue", () => {
  it("rejects an empty key with 400 before touching the database", async () => {
    const db = new FakeDb()
    expect(await readKeyValue(db.client, "user-1", "  ")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(0)
  })

  it("rejects an over-long key with 400", async () => {
    const db = new FakeDb()
    const result = await readKeyValue(
      db.client,
      "user-1",
      "k".repeat(MAX_KEY_LENGTH + 1)
    )
    expect(result).toMatchObject({ success: false, status: 400 })
  })

  it("returns the stored value", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM key_values/, { rows: [{ kv_value: "v" }] })
    expect(await readKeyValue(db.client, "user-1", "theme")).toEqual({
      success: true,
      value: "v",
      status: 200,
    })
  })

  it("returns 404 when the key is absent", async () => {
    const db = new FakeDb()
    db.on(/SELECT kv_value FROM key_values/, { rows: [] })
    expect((await readKeyValue(db.client, "user-1", "theme")).status).toBe(404)
  })
})

describe("readKeyValues", () => {
  it("returns every pair for the user", async () => {
    const db = new FakeDb()
    const rows = [{ kv_key: "a" }, { kv_key: "b" }]
    db.on(/FROM key_values/, { rows })
    expect(await readKeyValues(db.client, "user-1")).toEqual({
      success: true,
      pairs: rows,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM key_values/, pgError("08006"))
    expect((await readKeyValues(db.client, "user-1")).status).toBe(500)
  })
})

describe("searchKeyValues", () => {
  it("rejects an empty search term with 400", async () => {
    const db = new FakeDb()
    expect(await searchKeyValues(db.client, "user-1", "   ")).toMatchObject({
      success: false,
      status: 400,
    })
  })

  it("escapes LIKE wildcards so the term matches literally", async () => {
    const db = new FakeDb()
    db.on(/FROM key_values/, { rows: [] })
    await searchKeyValues(db.client, "user-1", "50%_off")
    // % and _ are escaped, then wrapped in %...% for a substring search.
    expect(db.calls[0].values[1]).toBe("%50\\%\\_off%")
  })
})

describe("setKeyValue", () => {
  it("creates a new key and reports created: true with 201", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM key_values/, { rows: [] })
    db.on(/count/, { rows: [{ count: 3 }] })
    db.on(/INSERT INTO key_values/, { rowCount: 1 })
    expect(await setKeyValue(db.client, "user-1", "theme", "dark")).toEqual({
      success: true,
      created: true,
      status: 201,
    })
  })

  it("updates an existing key and reports created: false with 200", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM key_values/, { rows: [{ "?column?": 1 }] })
    db.on(/INSERT INTO key_values/, { rowCount: 1 })
    expect(await setKeyValue(db.client, "user-1", "theme", "light")).toEqual({
      success: true,
      created: false,
      status: 200,
    })
  })

  it("rejects a new key once the per-user limit is reached with 409", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM key_values/, { rows: [] })
    db.on(/count/, { rows: [{ count: MAX_KEYS_PER_USER }] })
    const result = await setKeyValue(db.client, "user-1", "another", "v")
    expect(result).toMatchObject({ success: false, status: 409 })
    expect(db.calls.map((c) => c.text)).toContain("ROLLBACK")
  })

  it("rejects an invalid pair with 400 before opening a transaction", async () => {
    const db = new FakeDb()
    expect(await setKeyValue(db.client, "user-1", "", "v")).toMatchObject({
      success: false,
      status: 400,
    })
    expect(db.calls).toHaveLength(0)
  })
})

describe("deleteKeyValue", () => {
  it("succeeds when a row was removed", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM key_values/, { rowCount: 1 })
    expect(await deleteKeyValue(db.client, "user-1", "theme")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the key did not exist", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM key_values/, { rowCount: 0 })
    expect((await deleteKeyValue(db.client, "user-1", "theme")).status).toBe(
      404
    )
  })
})
