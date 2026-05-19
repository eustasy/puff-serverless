import { disableOrganisation } from "../../../../../../src/organisations.js"
import { can } from "../../../../../../src/permissions.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"

/** Disables an organisation (reversible — see `enable`). */
export const onRequestPost: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:disable")) {
    return resultNegative("You do not have permission to do this.", 403)
  }

  const result = await disableOrganisation(
    context.data.dbClient!,
    String(context.params.org_uuid)
  )
  if (!result.success) {
    return resultNegative(
      result.error
        ? "Could not disable the organisation."
        : "Organisation not found.",
      result.status
    )
  }
  return resultPositive("Organisation disabled.", result.status, {
    "HX-Trigger": "organisationChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
