import { setKeyValue } from "../../../../../../../../../../../src/team-role-keyvalues.js"
import { can } from "../../../../../../../../../../../src/permissions.js"
import { parseSetForm } from "../../../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import { methodNotAllowed, resultNegative, resultPositive } from "../../../../../../../../../../../src/utilities/responses.js"

/** Upserts a team-role-subject KV row owned by this organisation. */
export const onRequestPost: Handler<"org_uuid" | "team_uuid" | "role"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  const teamRoles = context.data.teamRoles ?? []
  if (!can(orgRoles, "org:keyvalues:write") && !can(teamRoles, "team:keyvalues:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const parsed = await parseSetForm(context.request)
  if (parsed instanceof Response) return parsed

  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)
  const role = String(context.params.role)
  const result = await setKeyValue(context.data.dbClient!, team_uuid, role, { type: "org", org_uuid }, parsed.key, parsed.value)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(`Key "${parsed.key}" ${result.created ? "created" : "updated"}.`, result.status, {
    "HX-Trigger": "teamRoleKeyValuesChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
