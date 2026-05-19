import { deleteKeyValue } from "../../../../../../../../../src/org-role-keyvalues.js"
import { can } from "../../../../../../../../../src/permissions.js"
import { parseKeyForm } from "../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../../../../../src/utilities/responses.js"

/** Removes an org-role-subject KV row owned by this organisation. */
export const onRequestPost: Handler<"org_uuid" | "role"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:keyvalues:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const parsed = await parseKeyForm(context.request)
  if (parsed instanceof Response) return parsed

  const org_uuid = String(context.params.org_uuid)
  const role = String(context.params.role)
  const result = await deleteKeyValue(
    context.data.dbClient!,
    org_uuid,
    role,
    { type: "org", org_uuid },
    parsed.key
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(`Key "${parsed.key}" deleted.`, result.status, {
    "HX-Trigger": "organisationRoleKeyValuesChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
