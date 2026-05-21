import { deleteOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../src/hooks/events.js"

/**
 * Permanently deletes an organisation — its teams and every membership row are
 * removed by `ON DELETE CASCADE`. Owner-only.
 */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:delete")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await deleteOrganisation(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(
      result.error
        ? "Could not delete the organisation."
        : "Organisation not found.",
      result.status
    )
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_DELETED,
    target_org_uuid: org_uuid,
  })
  return resultPositive("Organisation deleted.", result.status, {
    "HX-Trigger": "organisationsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
