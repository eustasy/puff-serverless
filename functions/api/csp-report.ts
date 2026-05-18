// Collects Content-Security-Policy violation reports from browsers.
//
// Wired up by public/_headers: the CSP carries both `report-uri
// /api/csp-report` (legacy — a single `application/csp-report` body shaped
// `{ "csp-report": { ... } }`) and `report-to csp-endpoint`, where the
// `csp-endpoint` name is mapped here by the `Reporting-Endpoints` header
// (modern Reporting API — an `application/reports+json` body that is an array
// of report objects). A browser uses one or the other; supporting both
// covers old and new engines.
//
// Unauthenticated by necessity — browsers send violation reports with no
// credentials — and intentionally DB-free: it only logs (surfaced via the
// Worker's observability logs). Anything that does not parse as a recognised
// report is dropped quietly, so the endpoint cannot be used to inject
// arbitrary log content at scale.

// Cap on violations logged per request: the Reporting API batches reports, so
// one POST can carry many — this bounds how much a single request can log.
const MAX_LOGGED = 20

// Free-text fields are truncated before logging — an inline-script `sample`
// can be an entire script.
const FIELD_MAX = 200

interface Violation {
  directive: string
  blockedURL: string
  documentURL: string
  sourceFile: string
  lineNumber: number | undefined
  sample: string
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function truncate(value: string): string {
  return value.length > FIELD_MAX ? value.slice(0, FIELD_MAX) + "…" : value
}

function logViolation(v: Violation): void {
  const location = v.sourceFile
    ? ` at ${truncate(v.sourceFile)}:${v.lineNumber ?? "?"}`
    : ""
  const sample = v.sample ? ` sample="${truncate(v.sample)}"` : ""
  console.warn(
    `CSP violation: '${v.directive}' blocked '${v.blockedURL || "inline"}' ` +
      `on '${v.documentURL}'${location}${sample}`
  )
}

export const onRequestPost: Handler = async (context) => {
  let payload: unknown
  try {
    payload = await context.request.json()
  } catch {
    // No parseable JSON body — nothing to log. Still acknowledge: the browser
    // ignores the response, and a non-2xx would only prompt pointless retries.
    return new Response(null, { status: 204 })
  }

  const violations: Violation[] = []

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    // Legacy `report-uri` body: { "csp-report": { ... } }
    const report = (payload as Record<string, unknown>)["csp-report"]
    if (report && typeof report === "object") {
      const r = report as Record<string, unknown>
      violations.push({
        directive:
          asString(r["effective-directive"]) ||
          asString(r["violated-directive"]) ||
          "unknown",
        blockedURL: asString(r["blocked-uri"]),
        documentURL: asString(r["document-uri"]),
        sourceFile: asString(r["source-file"]),
        lineNumber: asNumber(r["line-number"]),
        sample: asString(r["script-sample"]),
      })
    }
  } else if (Array.isArray(payload)) {
    // Modern Reporting API body: an array of report objects. The endpoint can
    // receive other report types (deprecation, intervention) — keep only CSP.
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (e["type"] !== "csp-violation") continue
      const body = e["body"]
      if (!body || typeof body !== "object") continue
      const b = body as Record<string, unknown>
      violations.push({
        directive: asString(b["effectiveDirective"]) || "unknown",
        blockedURL: asString(b["blockedURL"]),
        documentURL: asString(b["documentURL"]),
        sourceFile: asString(b["sourceFile"]),
        lineNumber: asNumber(b["lineNumber"]),
        sample: asString(b["sample"]),
      })
    }
  }

  for (const violation of violations.slice(0, MAX_LOGGED)) {
    logViolation(violation)
  }

  return new Response(null, { status: 204 })
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
