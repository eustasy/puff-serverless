import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../../../src/utilities/responses.js"
import { listAllSubscriptions } from "../../../../../../src/billing.js"
import { escapeHtml } from "../../../../../../src/utilities/escape.js"

// Operator-only read-out of every subscription across all orgs. Served at
// /api/db/auth/admin/billing/subscriptions, behind the operator gate in the
// admin middleware. Read-only — for support and dispute resolution.

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  const result = await listAllSubscriptions(dbClient)
  if (!result.success) {
    return resultNegative("Could not list subscriptions.", result.status)
  }

  let html = `<table><thead><tr>
      <th>Organisation</th>
      <th>App</th>
      <th>Status</th>
      <th>Tier</th>
      <th>Period end</th>
      <th>Provider sub</th>
    </tr></thead><tbody>`
  if (result.subscriptions.length > 0) {
    for (const sub of result.subscriptions) {
      html += `<tr>
        <td>${escapeHtml(sub.org_name)}</td>
        <td>${escapeHtml(sub.app_name)}</td>
        <td>${escapeHtml(sub.status)}</td>
        <td>${escapeHtml(sub.tier)}</td>
        <td>${escapeHtml(new Date(sub.current_period_end).toISOString())}</td>
        <td>${escapeHtml(sub.provider_subscription_id)}</td>
      </tr>`
    }
  } else {
    html += '<tr><td colspan="6">No subscriptions found.</td></tr>'
  }
  html += "</tbody></table>"

  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
