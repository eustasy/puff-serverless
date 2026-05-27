import { escapeHtml } from "./escape.js"

/** Render one cell, escaping DB-sourced text and showing a dash for null. */
export function cell(value: string | null): string {
  return value ? escapeHtml(value) : "—"
}
