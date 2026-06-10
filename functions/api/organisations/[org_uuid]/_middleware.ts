import { getOrgRoles } from "../../../../src/memberships.js"
import { resultNegative } from "../../../../src/utilities/responses.js"

/**
 * Resolves the caller's organisation roles for the `[org_uuid]` in the path and
 * stashes them on `context.data.orgRoles` for the endpoints below.
 *
 * It does not itself reject non-members: each endpoint authorises with
 * `can(...)`, which a caller holding no roles fails anyway. Leaving the gate to
 * the endpoints lets guests (team-only members) reach the team routes nested
 * under this path, where the team `_middleware.ts` authorises them.
 */
const resolveOrgRoles: Handler<"org_uuid"> = async (context) => {
  const { data, params, next } = context
  const org_uuid = String(params.org_uuid)

  const result = await getOrgRoles(data.dbClient!, org_uuid, data.user_uuid!)
  if (!result.success) {
    return resultNegative("Could not load your organisation membership.", 500)
  }
  data.orgRoles = result.roles
  return next()
}

export const onRequest = [resolveOrgRoles]
