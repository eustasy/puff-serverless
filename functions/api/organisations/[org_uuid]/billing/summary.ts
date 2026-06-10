import { listSubscriptions } from "../../../../../src/billing.js"
import { can } from "../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import { htmlResponse, methodNotAllowed, resultNegative } from "../../../../../src/utilities/responses.js"

/**
 * Returns an HTML fragment summarising all subscriptions for this organisation:
 * one row per subscription showing the app UUID, tier, status, and the end of
 * the current billing period.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:read")) {
    return resultNegative("You do not have permission to view billing.", 403)
  }

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)

  const result = await listSubscriptions(dbClient, org_uuid)
  if (result.error) {
    return resultNegative("Could not load subscriptions.", 500)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const { subscriptions } = result

  if (subscriptions.length === 0) {
    return htmlResponse(`<p class="result-neutral">No subscriptions found for this organisation.</p>`)
  }

  const rows = subscriptions
    .map(
      (sub) =>
        `<tr>
          <td>${escapeHtml(sub.app_uuid)}</td>
          <td>${escapeHtml(sub.tier)}</td>
          <td>${escapeHtml(sub.status)}</td>
          <td>${escapeHtml(sub.current_period_end.toISOString().slice(0, 10))}</td>
        </tr>`
    )
    .join("")

  return htmlResponse(
    `<table class="billing-summary">
      <thead>
        <tr>
          <th scope="col">App</th>
          <th scope="col">Tier</th>
          <th scope="col">Status</th>
          <th scope="col">Period ends</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
