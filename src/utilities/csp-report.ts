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

export function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

export function truncate(value: string): string {
  return value.length > FIELD_MAX ? value.slice(0, FIELD_MAX) + "…" : value
}

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
