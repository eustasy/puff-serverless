import { readTeam } from "../../../../../../../../src/teams.js"
import { getTeamRoles } from "../../../../../../../../src/memberships.js"
import { resultNegative } from "../../../../../../../../src/utilities/responses.js"

/**
 * Confirms the `[team_uuid]` belongs to the `[org_uuid]` in the path, then
 * resolves the caller's team roles into `context.data.teamRoles`.
 *
 * It does not reject non-members: team endpoints authorise with `can(...)`,
 * composing the team roles here with the organisation roles resolved upstream
 * (an org admin manages a team without holding a team role).
 */
const resolveTeam: Handler<"org_uuid" | "team_uuid"> = async (context) => {
  const { data, params, next } = context
  const org_uuid = String(params.org_uuid)
  const team_uuid = String(params.team_uuid)

  const team = await readTeam(data.dbClient!, team_uuid)
  if (team.error) {
    return resultNegative("Could not load the team.", 500)
  }
  // A team from another organisation must not be reachable under this path.
  if (!team.success || team.team.org_uuid !== org_uuid) {
    return resultNegative("Team not found.", 404)
  }

  const roles = await getTeamRoles(data.dbClient!, team_uuid, data.user_uuid!)
  if (!roles.success) {
    return resultNegative("Could not load your team membership.", 500)
  }
  data.teamRoles = roles.roles
  return next()
}

export const onRequest = [resolveTeam]
