import { readOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"

/** Returns an organisation's details as an HTML fragment. */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const result = await readOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const org = result.organisation
  const status = org.org_active ? "Active" : "Disabled"
  return htmlResponse(
    `<dl class="organisation-detail">
      <dt>Name</dt><dd>${escapeHtml(org.org_name)}</dd>
      <dt>URL slug</dt><dd>${escapeHtml(org.org_slug)}</dd>
      <dt>Status</dt><dd>${status}</dd>
    </dl>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
