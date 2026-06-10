import { setKeyValue } from "../../../../../../../src/user-keyvalues.js"
import { can } from "../../../../../../../src/permissions.js"
import { parseSetForm } from "../../../../../../../src/utilities/keyvalues-endpoint.js"
import { methodNotAllowed, resultNegative, resultPositive } from "../../../../../../../src/utilities/responses.js"

/** Upserts a user-subject KV row owned by this organisation. */
export const onRequestPost: Handler<"org_uuid" | "user_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:keyvalues:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const parsed = await parseSetForm(context.request)
  if (parsed instanceof Response) return parsed

  const org_uuid = String(context.params.org_uuid)
  const user_uuid = String(context.params.user_uuid)
  const result = await setKeyValue(context.data.dbClient!, user_uuid, { type: "org", org_uuid }, parsed.key, parsed.value)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(`Key "${parsed.key}" ${result.created ? "created" : "updated"}.`, result.status, {
    "HX-Trigger": "organisationUserKeyValuesChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
