import { updateOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"

/** Updates an organisation's name and slug. */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:update")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  let name = ""
  let slug = ""
  try {
    const formData = await context.request.formData()
    name = String(formData.get("name") ?? "")
    slug = String(formData.get("slug") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }

  const result = await updateOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid),
    name,
    slug
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive("Organisation updated.", result.status, {
    "HX-Trigger": "organisationChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
