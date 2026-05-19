import {
  readKeyValues,
  searchKeyValues,
} from "../../../../../../../../../src/org-role-keyvalues.js"
import { can } from "../../../../../../../../../src/permissions.js"
import { renderKeyValueTable } from "../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import {
  methodNotAllowed,
  resultNegative,
} from "../../../../../../../../../src/utilities/responses.js"

/**
 * Lists org-role-subject KV rows owned by this organisation — the perm/data
 * bundle assigned to a specific role within the org. Optional `?key=` filter.
 */
export const onRequestGet: Handler<"org_uuid" | "role"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:keyvalues:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const org_uuid = String(context.params.org_uuid)
  const role = String(context.params.role)
  const owner = { type: "org" as const, org_uuid }
  const url = new URL(context.request.url)
  const search = (url.searchParams.get("key") ?? "").trim()

  const result = search
    ? await searchKeyValues(
        context.data.dbClient!,
        org_uuid,
        role,
        owner,
        search
      )
    : await readKeyValues(context.data.dbClient!, org_uuid, role, owner)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return renderKeyValueTable(result.pairs, {
    removeBase: `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}/roles/${encodeURIComponent(role)}/keyvalues/remove`,
    triggerName: "organisationRoleKeyValuesChanged",
    canWrite: can(orgRoles, "org:keyvalues:write"),
    search: search || undefined,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
