import { escapeHtml } from "./escape.js"

/** Render one renderScheduleCell, escaping DB-sourced text and showing a dash for null. */
export function renderScheduleCell(value: string | null): string {
  return value ? escapeHtml(value) : "—"
}
