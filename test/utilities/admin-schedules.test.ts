import { describe, it, expect } from "vitest"
import { renderScheduleCell } from "../../src/utilities/admin-schedules.js"

describe("renderScheduleCell", () => {
  it("renders an em dash for null", () => {
    expect(renderScheduleCell(null)).toBe("—")
  })

  it("renders a plain value unchanged", () => {
    expect(renderScheduleCell("daily")).toBe("daily")
  })

  it("escapes HTML-significant characters in DB-sourced text", () => {
    expect(renderScheduleCell("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;")
  })
})
