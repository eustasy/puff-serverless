import {
  readKeyValues,
  searchKeyValues,
} from "../../../../../../../../../../../src/user-keyvalues.js"
import { assertGranteeInOrg } from "../../../../../../../../../../../src/entitlements.js"
import { can } from "../../../../../../../../../../../src/permissions.js"
import { renderKeyValueTable } from "../../../../../../../../../../../src/utilities/keyvalues-endpoint.js"
import {
  methodNotAllowed,
  resultNegative,
} from "../../../../../../../../../../../src/utilities/responses.js"

/**
 * Lists user-subject entitlements granted by this org under this app's
 * owner namespace. The grantee must be a member of the org — apps are
 * global, but entitlement scope is per-org.
 */
export const onRequestGet: Handler<
  "app_uuid" | "org_uuid" | "user_uuid"
> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const app = context.data.app!
  const org_uuid = String(context.params.org_uuid)
  const user_uuid = String(context.params.user_uuid)

  const inOrg = await assertGranteeInOrg(context.data.dbClient!, org_uuid, {
    type: "user",
    user_uuid,
  })
  if (!inOrg.success) {
    return resultNegative(
      inOrg.message ?? "Grantee is not in this organisation.",
      inOrg.status
    )
  }

  const owner = { type: "app" as const, app_uuid: app.app_uuid }
  const url = new URL(context.request.url)
  const search = (url.searchParams.get("key") ?? "").trim()
  const result = search
    ? await searchKeyValues(context.data.dbClient!, user_uuid, owner, search)
    : await readKeyValues(context.data.dbClient!, user_uuid, owner)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return renderKeyValueTable(result.pairs, {
    removeBase: `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}/apps/${encodeURIComponent(app.app_uuid)}/users/${encodeURIComponent(user_uuid)}/entitlements/remove`,
    triggerName: "appEntitlementsChanged",
    canWrite: can(orgRoles, "org:entitlements:write"),
    search: search || undefined,
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
