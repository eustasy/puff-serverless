import { listOrganisationsForUser } from "../../../../../src/organisations.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../src/utilities/responses.js"

/**
 * Lists the organisations the authenticated user belongs to, with the roles
 * they hold in each, as an HTML fragment.
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
    html += `<li data-org-uuid="${escapeHtml(org.org_uuid)}">
      <strong>${escapeHtml(org.org_name)}</strong>${disabled}
      — ${escapeHtml(org.roles.join(", "))}
    </li>`
  }
  html += "</ul>"
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
