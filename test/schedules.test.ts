import { describe, it, expect } from "vitest"
import { showSchedules } from "../src/schedules.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("showSchedules", () => {
  it("normalises SHOW SCHEDULES rows into schedule summaries", async () => {
    const db = new FakeDb()
    db.on(/SHOW SCHEDULES/, {
      rows: [
        {
          id: "1234567890",
          label: "row-level-ttl-100",
          schedule_status: "ACTIVE",
          next_run: new Date("2026-05-22T10:00:00Z"),
          state: "",
          recurrence: "0 * * * *",
          owner: "root",
          created: new Date("2026-05-01T09:00:00Z"),
        },
      ],
    })

    const result = await showSchedules(db.client)

    expect(result).toEqual({
      success: true,
      schedules: [
        {
          id: "1234567890",
          label: "row-level-ttl-100",
          status: "ACTIVE",
          next_run: "2026-05-22T10:00:00.000Z",
          state: "",
          recurrence: "0 * * * *",
          owner: "root",
          created: "2026-05-01T09:00:00.000Z",
        },
      ],
    })
  })

  it("returns an empty list when no schedules exist", async () => {
    const db = new FakeDb()
    db.on(/SHOW SCHEDULES/, { rows: [] })

    expect(await showSchedules(db.client)).toEqual({
      success: true,
      schedules: [],
    })
  })

  it("coerces missing timestamps and optional columns to null", async () => {
    const db = new FakeDb()
    db.on(/SHOW SCHEDULES/, {
      rows: [
        {
          id: 42,
          label: "row-level-ttl-200",
          schedule_status: "PAUSED",
          next_run: null,
          state: null,
          recurrence: null,
          owner: null,
          created: null,
        },
      ],
    })

    const result = await showSchedules(db.client)

    expect(result).toEqual({
      success: true,
      schedules: [
        {
          id: "42",
          label: "row-level-ttl-200",
          status: "PAUSED",
          next_run: null,
          state: null,
          recurrence: null,
          owner: null,
          created: null,
        },
      ],
    })
  })

  it("returns a 500 error envelope when the query fails", async () => {
    const db = new FakeDb()
    db.on(/SHOW SCHEDULES/, pgError("42501", "permission denied"))

    const result = await showSchedules(db.client)

    expect(result).toMatchObject({ status: 500 })
    expect("success" in result).toBe(false)
    expect((result as { error: string }).error).toMatch(/SHOW SCHEDULES/)
  })
})
