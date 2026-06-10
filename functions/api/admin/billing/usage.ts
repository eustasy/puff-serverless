import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../src/utilities/responses.js"
import { listUsageRollups } from "../../../../src/usage.js"
import { escapeHtml } from "../../../../src/utilities/escape.js"

// Operator-only usage dashboard: recent daily rollups per org/app/metric,
// with provider-sync state. Served at /api/admin/billing/usage behind
// the operator gate. Optional ?org_uuid= filter. Read-only.

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const { searchParams } = new URL(context.request.url)
  const org_uuid = searchParams.get("org_uuid") || undefined

  const result = await listUsageRollups(dbClient, { org_uuid })
  if (!result.success) {
    return resultNegative("Could not list usage rollups.", result.status)
  }

  let html = `<table><thead><tr>
      <th>Day</th>
      <th>Org</th>
      <th>App</th>
      <th>Metric</th>
      <th>Quantity</th>
      <th>Synced</th>
    </tr></thead><tbody>`
  if (result.rollups.length > 0) {
    for (const row of result.rollups) {
      const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10)
      html += `<tr>
        <td>${escapeHtml(day)}</td>
        <td>${escapeHtml(row.org_uuid)}</td>
        <td>${escapeHtml(row.app_uuid)}</td>
        <td>${escapeHtml(row.metric)}</td>
        <td>${escapeHtml(String(row.quantity))}</td>
        <td>${row.synced_at ? "yes" : "no"}</td>
      </tr>`
    }
  } else {
    html += '<tr><td colspan="6">No usage recorded.</td></tr>'
  }
  html += "</tbody></table>"

  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
