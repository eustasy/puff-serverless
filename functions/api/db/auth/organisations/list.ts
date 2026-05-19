import { listOrganisationsForUser } from "../../../../../src/organisations.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../src/utilities/responses.js"

/**
 * Lists the organisations the authenticated user belongs to, with the roles
 * they hold in each. Each row links to that organisation's dedicated
 * management page (`/organisations/:org_uuid`).
 */
export const onRequestGet: Handler = async (context) => {
  const result = await listOrganisationsForUser(
    context.data.dbClient!,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  if (result.organisations.length === 0) {
    return htmlResponse("<p>You are not a member of any organisations yet.</p>")
  }

  let html = '<ul class="organisation-list">'
  for (const org of result.organisations) {
    const disabled = org.org_active ? "" : " (disabled)"
    const pagePath = `/organisations/${encodeURIComponent(org.org_uuid)}`
    html += `<li>
      <strong>${escapeHtml(org.org_name)}</strong>${disabled}
      — ${escapeHtml(org.roles.join(", "))}
      <a class="btn-safe" href="${pagePath}">Manage</a>
    </li>`
  }
  html += "</ul>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
