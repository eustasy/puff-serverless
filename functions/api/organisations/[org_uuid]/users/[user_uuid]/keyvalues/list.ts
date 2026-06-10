import { readKeyValues, searchKeyValues } from "../../../../../../../src/user-keyvalues.js"
import { can } from "../../../../../../../src/permissions.js"
import { renderKeyValueTable } from "../../../../../../../src/utilities/keyvalues-endpoint.js"
import { methodNotAllowed, resultNegative } from "../../../../../../../src/utilities/responses.js"

/**
 * Lists user-subject KV rows owned by this organisation (data the org has
 * attached to a specific user). Optional `?key=` substring filter.
 */
export const onRequestGet: Handler<"org_uuid" | "user_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:keyvalues:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const org_uuid = String(context.params.org_uuid)
  const user_uuid = String(context.params.user_uuid)
  const owner = { type: "org" as const, org_uuid }
  const url = new URL(context.request.url)
  const search = (url.searchParams.get("key") ?? "").trim()

  const result = search
    ? await searchKeyValues(context.data.dbClient!, user_uuid, owner, search)
    : await readKeyValues(context.data.dbClient!, user_uuid, owner)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return renderKeyValueTable(result.pairs, {
    removeBase: `/api/organisations/${encodeURIComponent(org_uuid)}/users/${encodeURIComponent(user_uuid)}/keyvalues/remove`,
    triggerName: "organisationUserKeyValuesChanged",
    canWrite: can(orgRoles, "org:keyvalues:write"),
    search: search || undefined,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
