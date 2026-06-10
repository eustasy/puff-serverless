import { readKeyValues, searchKeyValues } from "../../../../../../../../../src/team-role-keyvalues.js"
import { can } from "../../../../../../../../../src/permissions.js"
import { renderKeyValueTable } from "../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import { methodNotAllowed, resultNegative } from "../../../../../../../../../src/utilities/responses.js"

/** Lists team-role-subject KV rows owned by this organisation. */
export const onRequestGet: Handler<"org_uuid" | "team_uuid" | "role"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(orgRoles, "org:keyvalues:read") && !can(teamRoles, "team:keyvalues:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)
  const role = String(context.params.role)
  const owner = { type: "org" as const, org_uuid }
  const url = new URL(context.request.url)
  const search = (url.searchParams.get("key") ?? "").trim()

  const result = search
    ? await searchKeyValues(context.data.dbClient!, team_uuid, role, owner, search)
    : await readKeyValues(context.data.dbClient!, team_uuid, role, owner)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  const canWrite = can(orgRoles, "org:keyvalues:write") || can(teamRoles, "team:keyvalues:write")
  return renderKeyValueTable(result.pairs, {
    removeBase: `/api/organisations/${encodeURIComponent(org_uuid)}/teams/${encodeURIComponent(team_uuid)}/roles/${encodeURIComponent(role)}/keyvalues/remove`,
    triggerName: "teamRoleKeyValuesChanged",
    canWrite,
    search: search || undefined,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
