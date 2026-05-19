import { describe, it, expect } from "vitest"
import { runInTransaction, Rollback } from "../../src/utilities/transaction.js"
import { FakeDb, pgError } from "../helpers/fake-db.js"

describe("runInTransaction", () => {
  it("wraps work in BEGIN/COMMIT and resolves with its return value", async () => {
    const db = new FakeDb()
    const result = await runInTransaction(db.client, async () => "ok")
    expect(result).toBe("ok")
    expect(db.calls.map((c) => c.text)).toEqual(["BEGIN", "COMMIT"])
  })

  it("runs work's own queries between BEGIN and COMMIT", async () => {
    const db = new FakeDb()
    db.on("UPDATE users", { rowCount: 1 })
    await runInTransaction(db.client, async () => {
      await db.client.query("UPDATE users SET x = 1")
    })
    expect(db.calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "UPDATE users SET x = 1",
      "COMMIT",
    ])
  })

  it("rolls back and rethrows a non-retryable error", async () => {
    const db = new FakeDb()
    const boom = new Error("boom")
    await expect(
      runInTransaction(db.client, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(db.calls.map((c) => c.text)).toEqual(["BEGIN", "ROLLBACK"])
  })

  it("does not retry a non-retryable error", async () => {
    const db = new FakeDb()
    let attempts = 0
    await expect(
      runInTransaction(db.client, async () => {
        attempts++
        throw new Error("nope")
      })
    ).rejects.toThrow("nope")
    expect(attempts).toBe(1)
  })

  it("rolls back and resolves with the value carried by a thrown Rollback", async () => {
    const db = new FakeDb()
    const result = await runInTransaction(db.client, async () => {
      throw new Rollback({ success: false, status: 404 })
    })
    expect(result).toEqual({ success: false, status: 404 })
    expect(db.calls.map((c) => c.text)).toEqual(["BEGIN", "ROLLBACK"])
  })

  it("does not retry a Rollback", async () => {
    const db = new FakeDb()
    let attempts = 0
    await runInTransaction(db.client, async () => {
      attempts++
      throw new Rollback("aborted")
    })
    expect(attempts).toBe(1)
  })

  it("retries the whole transaction on a serialization failure (40001)", async () => {
    const db = new FakeDb()
    let attempts = 0
    const result = await runInTransaction(db.client, async () => {
      attempts++
      if (attempts < 3) throw pgError("40001")
      return "succeeded on third try"
    })
    expect(result).toBe("succeeded on third try")
    expect(attempts).toBe(3)
    // The first two attempts roll back; the third commits.
    expect(db.calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "ROLLBACK",
      "BEGIN",
      "ROLLBACK",
      "BEGIN",
      "COMMIT",
    ])
  })

  it("gives up after 5 attempts when 40001 never clears", async () => {
    const db = new FakeDb()
    let attempts = 0
    await expect(
      runInTransaction(db.client, async () => {
        attempts++
        throw pgError("40001")
      })
    ).rejects.toMatchObject({ code: "40001" })
    expect(attempts).toBe(5)
  })
})

describe("Rollback", () => {
  it("carries its value", () => {
    expect(new Rollback({ a: 1 }).value).toEqual({ a: 1 })
    expect(new Rollback("x").value).toBe("x")
  })
})
