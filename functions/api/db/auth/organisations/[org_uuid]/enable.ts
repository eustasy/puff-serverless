import { enableOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../src/hooks/events.js"

/** Re-enables a disabled organisation. Gated by the same role as `disable`. */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:disable")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const result = await enableOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(
      result.error
        ? "Could not enable the organisation."
        : "Organisation not found.",
      result.status
    )
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_ENABLED,
    target_org_uuid: String(context.params.org_uuid),
  })
  return resultPositive("Organisation enabled.", result.status, {
    "HX-Trigger": "organisationChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
