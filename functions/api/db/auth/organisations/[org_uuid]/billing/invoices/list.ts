import { listInvoices } from "../../../../../../../../src/billing.js"
import { can } from "../../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../../src/utilities/escape.js"
import { htmlResponse, methodNotAllowed, resultNegative } from "../../../../../../../../src/utilities/responses.js"

/**
 * Returns an HTML fragment listing all invoices for this organisation:
 * one row per invoice showing status, amount, billing period, and a link
 * to the hosted invoice URL when available.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:read")) {
    return resultNegative("You do not have permission to view billing.", 403)
  }

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)

  const result = await listInvoices(dbClient, org_uuid)
  if (result.error) {
    return resultNegative("Could not load invoices.", 500)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const { invoices } = result

  if (invoices.length === 0) {
    return htmlResponse(`<p class="result-neutral">No invoices found for this organisation.</p>`)
  }

  const formatAmount = (cents: number, currency: string): string => {
    const major = (cents / 100).toFixed(2)
    return `${major} ${escapeHtml(currency.toUpperCase())}`
  }

  const rows = invoices
    .map((inv) => {
      const periodStart = inv.period_start.toISOString().slice(0, 10)
      const periodEnd = inv.period_end.toISOString().slice(0, 10)
      const invoiceLink = inv.hosted_invoice_url
        ? `<a href="${escapeHtml(inv.hosted_invoice_url)}" rel="noopener noreferrer" target="_blank">View</a>`
        : "—"
      return `<tr>
          <td>${escapeHtml(inv.status)}</td>
          <td>${formatAmount(inv.amount_cents, inv.currency)}</td>
          <td>${escapeHtml(periodStart)} – ${escapeHtml(periodEnd)}</td>
          <td>${invoiceLink}</td>
        </tr>`
    })
    .join("")

  return htmlResponse(
    `<table class="billing-invoices">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Amount</th>
          <th scope="col">Period</th>
          <th scope="col">Invoice</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
