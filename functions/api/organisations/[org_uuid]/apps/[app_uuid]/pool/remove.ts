import { deleteKeyValue } from "../../../../../../../src/organisation-keyvalues.js"
import { LICENSE_FLOATING_MAX_KEY } from "../../../../../../../src/apps.js"
import { can } from "../../../../../../../src/permissions.js"
import { methodNotAllowed, resultNegative, resultPositive } from "../../../../../../../src/utilities/responses.js"

/**
 * Clears this org's per-org floating pool size for the app. The app's
 * declared default (from `app_key_values` subject = owner = app) takes over,
 * if any.
 */
export const onRequestPost: Handler<"app_uuid" | "org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const app = context.data.app!
  const org_uuid = String(context.params.org_uuid)
  const result = await deleteKeyValue(context.data.dbClient!, org_uuid, { type: "app", app_uuid: app.app_uuid }, LICENSE_FLOATING_MAX_KEY)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive("Pool size cleared.", result.status, {
    "HX-Trigger": "appEntitlementsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
