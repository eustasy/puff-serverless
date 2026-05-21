import { deleteKeyValue } from "../../../../../../../../../../../src/team-keyvalues.js"
import { assertGranteeInOrg } from "../../../../../../../../../../../src/entitlements.js"
import { can } from "../../../../../../../../../../../src/permissions.js"
import { parseKeyForm } from "../../../../../../../../../../../src/utilities/entitlements-endpoint.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../../../../../../../src/utilities/responses.js"
import { emitFromContext } from "../../../../../../../../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../../../../../../../../src/hooks/events.js"

/** Removes a team-subject entitlement under the app's owner namespace. */
export const onRequestPost: Handler<
  "app_uuid" | "org_uuid" | "team_uuid"
> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:write")) {
    return resultNegative("You cannot modify this data.", 403)
  }
  const parsed = await parseKeyForm(context.request)
  if (parsed instanceof Response) return parsed

  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)
  const app = context.data.app!

  const inOrg = await assertGranteeInOrg(context.data.dbClient!, org_uuid, {
    type: "team",
    team_uuid,
  })
  if (!inOrg.success) {
    return resultNegative(
      inOrg.message ?? "Team is not in this organisation.",
      inOrg.status
    )
  }

  const result = await deleteKeyValue(
    context.data.dbClient!,
    team_uuid,
    { type: "app", app_uuid: app.app_uuid },
    parsed.key
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  await emitFromContext(context, {
    event_type: EVENTS.ORG_TEAM_ENTITLEMENTS_REMOVED,
    target_org_uuid: org_uuid,
    target_team_uuid: team_uuid,
    target_app_uuid: app.app_uuid,
    target_label: parsed.key,
  })
  return resultPositive(`Entitlement "${parsed.key}" revoked.`, result.status, {
    "HX-Trigger": "appEntitlementsChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
