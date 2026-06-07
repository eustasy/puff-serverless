import { describe, it, expect } from "vitest"
import {
  ownerFilter,
  ownerInsertValues,
  validatePair,
  escapeLikePattern,
  readKeyValueGeneric,
  readKeyValuesGeneric,
  searchKeyValuesGeneric,
  deleteKeyValueGeneric,
  upsertKeyValue,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  type Owner,
  type KeyValueSpec,
} from "../../src/utilities/keyvalues-shared.js"
import { FakeDb, pgError } from "../helpers/fake-db.js"

const spec: KeyValueSpec = {
  table: "test_kvs",
  subjectColumns: ["subject_uuid"],
  selectColumns: "subject_uuid, kv_key, kv_value",
  label: "test",
}
const userOwner: Owner = { type: "user", user_uuid: "u-1" }
const orgOwner: Owner = { type: "org", org_uuid: "org-1" }
const appOwner: Owner = { type: "app", app_uuid: "app-1" }

describe("ownerFilter", () => {
  it("builds the app-owner filter at the given param index", () => {
    const f = ownerFilter(appOwner, 3)
    expect(f.sql).toBe("owner_app_uuid = $3")
    expect(f.values).toEqual(["app-1"])
  })
})

describe("ownerInsertValues", () => {
  it("user owner sets user column only", () => {
    expect(ownerInsertValues(userOwner)).toEqual(["u-1", null, null])
  })

  it("app owner sets app column only", () => {
    expect(ownerInsertValues(appOwner)).toEqual([null, null, "app-1"])
  })
})

describe("validatePair", () => {
  it("accepts a valid key and value", () => {
    expect(validatePair("my-key", "my-value")).toBeNull()
  })

  it("rejects an empty key", () => {
    expect(validatePair("")).toBe("A key is required.")
    expect(validatePair("   ")).toBe("A key is required.")
  })

  it("rejects a key exceeding MAX_KEY_LENGTH", () => {
    expect(validatePair("k".repeat(MAX_KEY_LENGTH + 1))).toBe(`Keys cannot be longer than ${MAX_KEY_LENGTH} characters.`)
  })

  it("rejects a value exceeding MAX_VALUE_LENGTH", () => {
    expect(validatePair("key", "v".repeat(MAX_VALUE_LENGTH + 1))).toBe(`Values cannot be longer than ${MAX_VALUE_LENGTH} characters.`)
  })
})

describe("escapeLikePattern", () => {
  it("escapes percent, underscore, and backslash", () => {
    expect(escapeLikePattern("100%_done\\here")).toBe("100\\%\\_done\\\\here")
  })

  it("leaves characters that need no escaping unchanged", () => {
    expect(escapeLikePattern("normal-key")).toBe("normal-key")
  })
})

describe("readKeyValueGeneric", () => {
  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM test_kvs/, pgError("08006", "connection lost"))
    const result = await readKeyValueGeneric(db.client, spec, ["s-1"], userOwner, "k")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("readKeyValuesGeneric", () => {
  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM test_kvs/, pgError("08006", "connection lost"))
    const result = await readKeyValuesGeneric(db.client, spec, ["s-1"], userOwner)
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("searchKeyValuesGeneric", () => {
  it("returns 400 when the pattern is empty", async () => {
    const db = new FakeDb()
    const result = await searchKeyValuesGeneric(db.client, spec, ["s-1"], userOwner, "")
    expect(result).toMatchObject({ success: false, status: 400, message: "A search term is required." })
    expect(db.calls).toHaveLength(0)
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM test_kvs/, pgError("08006", "connection lost"))
    const result = await searchKeyValuesGeneric(db.client, spec, ["s-1"], userOwner, "pattern")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("deleteKeyValueGeneric", () => {
  it("returns 404 when no row was deleted", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM test_kvs/, { rowCount: 0 })
    const result = await deleteKeyValueGeneric(db.client, spec, ["s-1"], userOwner, "k")
    expect(result).toMatchObject({ success: false, status: 404 })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/DELETE FROM test_kvs/, pgError("08006", "connection lost"))
    const result = await deleteKeyValueGeneric(db.client, spec, ["s-1"], userOwner, "k")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("upsertKeyValue", () => {
  it("returns 409 when the per-owner key limit is reached on a new key", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM test_kvs/, { rows: [] }) // key is new
    db.on(/SELECT count/, { rows: [{ count: 256 }] }) // at the limit
    const result = await upsertKeyValue(db.client, "test_kvs", ["subject_uuid"], ["s-1"], orgOwner, "new-key", "v")
    expect(result).toMatchObject({ success: false, status: 409 })
  })

  it("returns 500 when an unexpected DB error occurs inside the transaction", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM test_kvs/, pgError("08006", "connection lost"))
    const result = await upsertKeyValue(db.client, "test_kvs", ["subject_uuid"], ["s-1"], orgOwner, "k", "v")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})
