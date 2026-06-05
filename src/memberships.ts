// Membership — role grants that tie users to organisations and teams (Phase 6).
//
// Each (scope, user, role) is one row; a user may hold any number of roles in a
// scope. Role grants are never gated on prior membership — an owner can grant a
// role to any user — so `addOrgMember` doubles as the way an external user
// becomes a member or guest.
//
// One integrity rule is enforced here: an organisation must always keep at
// least one `owner` (see `removeOrgMember` / `setOrgMemberRoles`). Finer,
// target-dependent rules (an admin may not grant `owner`) belong to the
// endpoint layer.

import { runInTransaction, Rollback } from "./utilities/transaction.js"
import { OWNER_ROLE, isOrgRole, isTeamRole } from "./permissions.js"

// SQLSTATE for a foreign-key violation — the organisation, team, or user named
// in a grant does not exist.
const FK_VIOLATION = "23503"

// --- Scope-generic membership ----------------------------------------------
//
// Organisation and team membership are the same shape over different tables.
// A scope descriptor captures the four differences — the table, its id column,
// the role validator, and the noun used in messages — so the generic helpers
// below serve both. The one asymmetry, the organisation's last-owner invariant,
// stays explicit: it is passed to setScopeMemberRoles only for the org scope
// (see setOrgMemberRoles), and removeOrgMember keeps its own guarded path.

interface MembershipScope {
  table: "organisation_members" | "team_members"
  column: "org_uuid" | "team_uuid"
  isRole: (role: string) => boolean
  /** Lowercase noun for user-facing messages, e.g. "organisation" | "team". */
  noun: string
}

const ORG_SCOPE: MembershipScope = { table: "organisation_members", column: "org_uuid", isRole: isOrgRole, noun: "organisation" }
const TEAM_SCOPE: MembershipScope = { table: "team_members", column: "team_uuid", isRole: isTeamRole, noun: "team" }

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Generic body of {@link addOrgMember} / {@link addTeamMember}. */
async function addScopeMember(
  dbClient: DbClient,
  scope: MembershipScope,
  scope_id: string,
  user_uuid: string,
  role: string,
  added_by: string | null
): Promise<Envelope> {
  if (!scope.isRole(role)) {
    return { success: false, message: `Unknown ${scope.noun} role.`, status: 400 }
  }
  try {
    const result = await dbClient.query(
      `INSERT INTO ${scope.table} (${scope.column}, user_uuid, role, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (${scope.column}, user_uuid, role) DO NOTHING`,
      [scope_id, user_uuid, role, added_by]
    )
    return { success: true, status: (result.rowCount ?? 0) > 0 ? 201 : 200 }
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      return { success: false, message: `${capitalise(scope.noun)} or user not found.`, status: 404 }
    }
    console.error(`Error in addScopeMember (${scope.noun}):`, error)
    return {
      error: true,
      message: `Could not add ${scope.noun} member.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Generic body of {@link setOrgMemberRoles} / {@link setTeamMemberRoles}.
 * `enforceInvariant`, when supplied, runs inside the transaction before the
 * rewrite and may throw a {@link Rollback} to abort — this is how the
 * organisation's last-owner guard is applied without teams (which have no such
 * rule) paying for it. The guard runs before the DELETE, so a rejected change
 * never touches the table.
 */
async function setScopeMemberRoles(
  dbClient: DbClient,
  scope: MembershipScope,
  scope_id: string,
  user_uuid: string,
  roles: string[],
  added_by: string | null,
  enforceInvariant?: (wanted: string[]) => Promise<void>
): Promise<Envelope> {
  const wanted = [...new Set(roles)]
  if (wanted.length === 0) {
    return { success: false, message: "At least one role is required.", status: 400 }
  }
  if (!wanted.every(scope.isRole)) {
    return { success: false, message: `Unknown ${scope.noun} role.`, status: 400 }
  }
  try {
    return await runInTransaction(dbClient, async (): Promise<Envelope> => {
      if (enforceInvariant) {
        await enforceInvariant(wanted)
      }
      await dbClient.query(`DELETE FROM ${scope.table} WHERE ${scope.column} = $1 AND user_uuid = $2`, [scope_id, user_uuid])
      for (const role of wanted) {
        await dbClient.query(`INSERT INTO ${scope.table} (${scope.column}, user_uuid, role, added_by) VALUES ($1, $2, $3, $4)`, [
          scope_id,
          user_uuid,
          role,
          added_by,
        ])
      }
      return { success: true, status: 200 }
    })
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      return { success: false, message: `${capitalise(scope.noun)} or user not found.`, status: 404 }
    }
    console.error(`Error in setScopeMemberRoles (${scope.noun}):`, error)
    return {
      error: true,
      message: `Could not update ${scope.noun} member roles.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Generic body of {@link listOrgMembers} / {@link listTeamMembers}. */
async function listScopeMembers(
  dbClient: DbClient,
  scope: MembershipScope,
  scope_id: string
): Promise<Envelope<{ members: ScopeMember[] }>> {
  try {
    const result = await dbClient.query(
      `SELECT m.user_uuid, u.user_name,
              array_agg(m.role ORDER BY m.role) AS roles,
              min(m.added_at) AS joined_at
       FROM ${scope.table} m
       JOIN users u ON u.user_uuid = m.user_uuid
       WHERE m.${scope.column} = $1
       GROUP BY m.user_uuid, u.user_name
       ORDER BY u.user_name ASC`,
      [scope_id]
    )
    return { success: true, members: result.rows, status: 200 }
  } catch (error) {
    console.error(`Error in listScopeMembers (${scope.noun}):`, error)
    return {
      error: true,
      message: `Could not list ${scope.noun} members.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Generic body of {@link getOrgRoles} / {@link getTeamRoles}. */
async function getScopeRoles(
  dbClient: DbClient,
  scope: MembershipScope,
  scope_id: string,
  user_uuid: string
): Promise<Envelope<{ roles: string[] }>> {
  try {
    const result = await dbClient.query(`SELECT role FROM ${scope.table} WHERE ${scope.column} = $1 AND user_uuid = $2`, [
      scope_id,
      user_uuid,
    ])
    return { success: true, roles: result.rows.map((row) => row.role), status: 200 }
  } catch (error) {
    console.error(`Error in getScopeRoles (${scope.noun}):`, error)
    return {
      error: true,
      message: `Could not read ${scope.noun} roles.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Organisation membership ----------------------------------------------

/**
 * Grants `role` to a user in an organisation. Idempotent — re-granting an
 * existing role succeeds without error. The user need not already be a member.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @param {string} user_uuid - The user being granted the role.
 * @param {string} role - An organisation role (see `ORG_ROLES`).
 * @param {string | null} added_by - UUID of the acting user, or null.
 * @returns {Promise<Envelope>} `{ success: true, status: 201 }` (new) / `200` (already held), `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function addOrgMember(
  dbClient: DbClient,
  org_uuid: string,
  user_uuid: string,
  role: string,
  added_by: string | null
): Promise<Envelope> {
  return await addScopeMember(dbClient, ORG_SCOPE, org_uuid, user_uuid, role, added_by)
}

/**
 * Removes a user from an organisation — every role they hold in it. Refuses to
 * remove the organisation's last `owner`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @param {string} user_uuid - The user being removed.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, message, status: 404|409 }`, or an error envelope.
 */
export async function removeOrgMember(dbClient: DbClient, org_uuid: string, user_uuid: string): Promise<Envelope> {
  try {
    return await runInTransaction(dbClient, async (): Promise<Envelope> => {
      const counts = await dbClient.query(
        `SELECT
           (count(*) FILTER (WHERE role = $3))::INT AS owners,
           (count(*) FILTER (WHERE user_uuid = $2 AND role = $3))::INT AS target_owner,
           (count(*) FILTER (WHERE user_uuid = $2))::INT AS target_rows
         FROM organisation_members WHERE org_uuid = $1`,
        [org_uuid, user_uuid, OWNER_ROLE]
      )
      const { owners, target_owner, target_rows } = counts.rows[0]
      if (target_rows === 0) {
        throw new Rollback<Envelope>({
          success: false,
          message: "That user is not a member of this organisation.",
          status: 404,
        })
      }
      if (target_owner > 0 && owners <= 1) {
        throw new Rollback<Envelope>({
          success: false,
          message: "An organisation must keep at least one owner.",
          status: 409,
        })
      }
      await dbClient.query("DELETE FROM organisation_members WHERE org_uuid = $1 AND user_uuid = $2", [org_uuid, user_uuid])
      return { success: true, status: 200 }
    })
  } catch (error) {
    console.error("Error in removeOrgMember:", error)
    return {
      error: true,
      message: "Could not remove organisation member.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Replaces a user's entire role set in an organisation. Adds the user if they
 * were not already a member. Refuses a change that would leave the
 * organisation with no `owner`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @param {string} user_uuid - The user whose roles are being set.
 * @param {string[]} roles - The new role set (deduplicated; must be non-empty).
 * @param {string | null} added_by - UUID of the acting user, or null.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, message, status: 400|404|409 }`, or an error envelope.
 */
export async function setOrgMemberRoles(
  dbClient: DbClient,
  org_uuid: string,
  user_uuid: string,
  roles: string[],
  added_by: string | null
): Promise<Envelope> {
  return await setScopeMemberRoles(dbClient, ORG_SCOPE, org_uuid, user_uuid, roles, added_by, async (wanted) => {
    const counts = await dbClient.query(
      `SELECT
         (count(*) FILTER (WHERE role = $3))::INT AS owners,
         (count(*) FILTER (WHERE user_uuid = $2 AND role = $3))::INT AS target_owner
       FROM organisation_members WHERE org_uuid = $1`,
      [org_uuid, user_uuid, OWNER_ROLE]
    )
    const { owners, target_owner } = counts.rows[0]
    // Demoting the only owner would leave the organisation ownerless.
    if (target_owner > 0 && owners <= 1 && !wanted.includes(OWNER_ROLE)) {
      throw new Rollback<Envelope>({
        success: false,
        message: "An organisation must keep at least one owner.",
        status: 409,
      })
    }
  })
}

/** A scope member: one user, their display name, and their roles in the scope. */
export interface ScopeMember {
  user_uuid: string
  user_name: string
  roles: string[]
  joined_at: Date
}

/**
 * Lists an organisation's members, each with their roles, ordered by name.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope<{ members: ScopeMember[] }>>} `{ success: true, members, status: 200 }` or an error envelope.
 */
export async function listOrgMembers(dbClient: DbClient, org_uuid: string): Promise<Envelope<{ members: ScopeMember[] }>> {
  return await listScopeMembers(dbClient, ORG_SCOPE, org_uuid)
}

// --- Team membership -------------------------------------------------------

/**
 * Grants `role` to a user in a team. Idempotent. Team membership is independent
 * of organisation membership — a team grant alone makes the user a guest.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @param {string} user_uuid - The user being granted the role.
 * @param {string} role - A team role (see `TEAM_ROLES`).
 * @param {string | null} added_by - UUID of the acting user, or null.
 * @returns {Promise<Envelope>} `{ success: true, status: 201 }` (new) / `200` (already held), `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function addTeamMember(
  dbClient: DbClient,
  team_uuid: string,
  user_uuid: string,
  role: string,
  added_by: string | null
): Promise<Envelope> {
  return await addScopeMember(dbClient, TEAM_SCOPE, team_uuid, user_uuid, role, added_by)
}

/**
 * Removes a user from a team — every role they hold in it.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @param {string} user_uuid - The user being removed.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, message, status: 404 }`, or an error envelope.
 */
export async function removeTeamMember(dbClient: DbClient, team_uuid: string, user_uuid: string): Promise<Envelope> {
  try {
    const result = await dbClient.query("DELETE FROM team_members WHERE team_uuid = $1 AND user_uuid = $2", [team_uuid, user_uuid])
    if ((result.rowCount ?? 0) === 0) {
      return {
        success: false,
        message: "That user is not a member of this team.",
        status: 404,
      }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in removeTeamMember:", error)
    return {
      error: true,
      message: "Could not remove team member.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Replaces a user's entire role set in a team. Adds the user if they were not
 * already a member.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @param {string} user_uuid - The user whose roles are being set.
 * @param {string[]} roles - The new role set (deduplicated; must be non-empty).
 * @param {string | null} added_by - UUID of the acting user, or null.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function setTeamMemberRoles(
  dbClient: DbClient,
  team_uuid: string,
  user_uuid: string,
  roles: string[],
  added_by: string | null
): Promise<Envelope> {
  return await setScopeMemberRoles(dbClient, TEAM_SCOPE, team_uuid, user_uuid, roles, added_by)
}

/**
 * Lists a team's members, each with their roles, ordered by name.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @returns {Promise<Envelope<{ members: ScopeMember[] }>>} `{ success: true, members, status: 200 }` or an error envelope.
 */
export async function listTeamMembers(dbClient: DbClient, team_uuid: string): Promise<Envelope<{ members: ScopeMember[] }>> {
  return await listScopeMembers(dbClient, TEAM_SCOPE, team_uuid)
}

// --- Role lookups ----------------------------------------------------------

/**
 * Returns every organisation-scoped role a user holds in an organisation. An
 * empty array means the user is not an organisation member (they may still be
 * a guest via a team — see `getTeamRoles`).
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @param {string} user_uuid - The user UUID.
 * @returns {Promise<Envelope<{ roles: string[] }>>} `{ success: true, roles, status: 200 }` or an error envelope.
 */
export async function getOrgRoles(dbClient: DbClient, org_uuid: string, user_uuid: string): Promise<Envelope<{ roles: string[] }>> {
  return await getScopeRoles(dbClient, ORG_SCOPE, org_uuid, user_uuid)
}

/**
 * Returns every team-scoped role a user holds in a team.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @param {string} user_uuid - The user UUID.
 * @returns {Promise<Envelope<{ roles: string[] }>>} `{ success: true, roles, status: 200 }` or an error envelope.
 */
export async function getTeamRoles(dbClient: DbClient, team_uuid: string, user_uuid: string): Promise<Envelope<{ roles: string[] }>> {
  return await getScopeRoles(dbClient, TEAM_SCOPE, team_uuid, user_uuid)
}
