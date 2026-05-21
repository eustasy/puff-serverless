import { updateOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../src/hooks/events.js"

/** Updates an organisation's name. */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:update")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let name = ""
  try {
    const formData = await context.request.formData()
    name = String(formData.get("name") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }

  const result = await updateOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid),
    name
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_UPDATED,
    target_org_uuid: String(context.params.org_uuid),
    target_label: name,
  })
  return resultPositive("Organisation updated.", result.status, {
    "HX-Trigger": "organisationChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
