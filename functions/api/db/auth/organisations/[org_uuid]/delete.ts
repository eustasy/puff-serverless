import { deleteOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"

/**
 * Permanently deletes an organisation — its teams and every membership row are
 * removed by `ON DELETE CASCADE`. Owner-only.
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:delete")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const result = await deleteOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(
      result.error
        ? "Could not delete the organisation."
        : "Organisation not found.",
      result.status
    )
  }
  return resultPositive("Organisation deleted.", result.status, {
    "HX-Trigger": "organisationsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
