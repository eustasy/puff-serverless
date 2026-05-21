import {
  readKeyValues,
  searchKeyValues,
} from "../../../../../../../../../../../src/team-keyvalues.js"
import { assertGranteeInOrg } from "../../../../../../../../../../../src/entitlements.js"
import { can } from "../../../../../../../../../../../src/permissions.js"
import { renderKeyValueTable } from "../../../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import {
  methodNotAllowed,
  resultNegative,
} from "../../../../../../../../../../../src/utilities/responses.js"

/** Lists team-subject entitlements under the app's owner namespace. */
export const onRequestGet: Handler<
  "app_uuid" | "org_uuid" | "team_uuid"
> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const app = context.data.app!
  const org_uuid = String(context.params.org_uuid)
  const team_uuid = String(context.params.team_uuid)

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

  const owner = { type: "app" as const, app_uuid: app.app_uuid }
  const url = new URL(context.request.url)
  const search = (url.searchParams.get("key") ?? "").trim()
  const result = search
    ? await searchKeyValues(context.data.dbClient!, team_uuid, owner, search)
    : await readKeyValues(context.data.dbClient!, team_uuid, owner)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return renderKeyValueTable(result.pairs, {
    removeBase: `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}/apps/${encodeURIComponent(app.app_uuid)}/teams/${encodeURIComponent(team_uuid)}/entitlements/remove`,
    triggerName: "appEntitlementsChanged",
    canWrite: can(orgRoles, "org:entitlements:write"),
    search: search || undefined,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
