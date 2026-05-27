/** Parses the OPERATOR_UUIDS env var — a comma/whitespace-separated list — into a Set. */
export function parseOperatorUuids(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
}
