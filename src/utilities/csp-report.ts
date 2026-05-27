// Free-text fields are truncated before logging — an inline-script `sample`
// can be an entire script.
const FIELD_MAX = 200

export interface Violation {
  directive: string
  blockedURL: string
  documentURL: string
  sourceFile: string
  lineNumber: number | undefined
  sample: string
}

/** Returns the value as a string, or "" if it is not a string. */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Returns the value as a number, or undefined if it is not a number. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

/** Clips the string to FIELD_MAX characters to keep log lines bounded. */
export function truncate(value: string): string {
  return value.length > FIELD_MAX ? value.slice(0, FIELD_MAX) + "…" : value
}

/** Formats and logs a CSP violation report as a structured console warning. */
export function logViolation(v: Violation): void {
  const location = v.sourceFile
    ? ` at ${truncate(v.sourceFile)}:${v.lineNumber ?? "?"}`
    : ""
  const sample = v.sample ? ` sample="${truncate(v.sample)}"` : ""
  console.warn(
    `CSP violation: '${v.directive}' blocked '${v.blockedURL || "inline"}' ` +
      `on '${v.documentURL}'${location}${sample}`
  )
}
