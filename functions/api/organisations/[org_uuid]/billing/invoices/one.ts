import { getInvoice } from "../../../../../../src/billing.js"
import { can } from "../../../../../../src/permissions.js"
import { methodNotAllowed, resultNegative } from "../../../../../../src/utilities/responses.js"

/**
 * Redirects to the hosted invoice URL for a single invoice. The `invoice_uuid`
 * is read from the query string. Branches on `HX-Request` to send either an
 * HTMX redirect or a standard browser `Location` header.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:billing:read")) {
    return resultNegative("You do not have permission to view billing.", 403)
  }

  const { searchParams } = new URL(context.request.url)
  const invoice_uuid = searchParams.get("invoice_uuid")
  if (!invoice_uuid) {
    return resultNegative("invoice_uuid is required.", 400)
  }

  const dbClient = context.data.dbClient!
  const org_uuid = String(context.params.org_uuid)

  const result = await getInvoice(dbClient, org_uuid, invoice_uuid)
  if (result.error) {
    return resultNegative("Could not load invoice.", 500)
  }
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const { invoice } = result
  if (!invoice || !invoice.hosted_invoice_url) {
    return resultNegative("Invoice not found.", 404)
  }

  const target = invoice.hosted_invoice_url
  const isHtmx = context.request.headers.get("HX-Request") === "true"
  return new Response(null, {
    status: 303,
    headers: isHtmx ? { "HX-Redirect": target } : { Location: target },
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
