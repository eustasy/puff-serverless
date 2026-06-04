/**
 * Escape a string so it can be safely interpolated into HTML text or
 * attribute values. Handles &, <, >, ", '. Coerces non-strings via String().
 * Null/undefined become "" to keep callers free of pre-checks.
 *
 * @param {*} value - Value to escape.
 * @returns {string} HTML-safe string.
 */
export function escapeHtml(value: unknown) {
  if (value === null || value === undefined) return ""
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}
