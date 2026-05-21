import { setKeyValue } from "../../../../../../../../../src/organisation-keyvalues.js"
import { LICENSE_FLOATING_MAX_KEY } from "../../../../../../../../../src/apps.js"
import { can } from "../../../../../../../../../src/permissions.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../../../../../src/utilities/responses.js"

/**
 * Sets this org's floating-licence pool size for the app. Stored as
 * `license:floating:max` on `organisation_key_values` (subject = org,
 * owner = app). The form takes a `max` integer ≥ 0.
 */
export const onRequestPost: Handler<"app_uuid" | "org_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const app = context.data.app!
  if (app.app_licensing_mode !== "floating") {
    return resultNegative(
      "Pool size is only meaningful for floating-licence apps.",
      409
    )
  }

  let form: FormData
  try {
    form = await context.request.formData()
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }
  const raw = form.get("max")
  if (typeof raw !== "string" || raw.trim() === "") {
    return resultNegative("A maximum seat count is required.", 400)
  }
  const max = Number.parseInt(raw, 10)
  if (!Number.isFinite(max) || max < 0 || max > 1_000_000) {
    return resultNegative(
      "Maximum seat count must be a non-negative integer.",
      400
    )
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await setKeyValue(
    context.data.dbClient!,
    org_uuid,
    { type: "app", app_uuid: app.app_uuid },
    LICENSE_FLOATING_MAX_KEY,
    String(max)
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(
    `Pool size ${result.created ? "set" : "updated"} to ${max}.`,
    result.status,
    { "HX-Trigger": "appEntitlementsChanged" }
  )
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
