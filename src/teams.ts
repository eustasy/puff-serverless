// Teams — a subdivision of an organisation (Phase 6).
//
// A team always belongs to one organisation (FK `ON DELETE CASCADE`). Team
// membership lives in `team_members` (see src/memberships.ts) and is
// independent of organisation membership — a user with only team grants is a
// guest of the organisation. Teams are identified solely by `team_uuid` —
// there is no slug, and names need not be unique within an organisation.

/** Longest accepted team display name. */
export const MAX_NAME_LENGTH = 128

const TEAM_COLUMNS = "team_uuid, org_uuid, team_name, team_created_at"

/** Validates a team name. Returns an error message, or null. */
function validateName(name: string): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return "A team name is required."
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return `Names cannot be longer than ${MAX_NAME_LENGTH} characters.`
  }
  return null
}

/**
 * Creates a team within an organisation. The caller is responsible for the
 * team's first members.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The owning organisation's UUID.
 * @param {string} name - Display name.
 * @returns {Promise<Envelope<{ team: TeamRow }>>} `{ success: true, team, status: 201 }`, `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function createTeam(
  dbClient: DbClient,
  org_uuid: string,
  name: string
): Promise<Envelope<{ team: TeamRow }>> {
  const invalid = validateName(name)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const team_uuid = crypto.randomUUID()
    const result = await dbClient.query(
      `INSERT INTO teams (team_uuid, org_uuid, team_name)
       VALUES ($1, $2, $3)
       RETURNING ${TEAM_COLUMNS}`,
      [team_uuid, org_uuid, name.trim()]
    )
    return { success: true, team: result.rows[0], status: 201 }
  } catch (error) {
    // A foreign-key violation means the organisation no longer exists.
    if ((error as { code?: string }).code === "23503") {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    console.error("Error in createTeam:", error)
    return {
      error: true,
      message: "Could not create team.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reads a team by UUID.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @returns {Promise<Envelope<{ team: TeamRow }>>} `{ success: true, team, status: 200 }`, `{ success: false, message, status: 404 }`, or an error envelope.
 */
export async function readTeam(
  dbClient: DbClient,
  team_uuid: string
): Promise<Envelope<{ team: TeamRow }>> {
  try {
    const result = await dbClient.query(
      `SELECT ${TEAM_COLUMNS} FROM teams WHERE team_uuid = $1 LIMIT 1`,
      [team_uuid]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Team not found.", status: 404 }
    }
    return { success: true, team: result.rows[0], status: 200 }
  } catch (error) {
    console.error("Error in readTeam:", error)
    return {
      error: true,
      message: "Could not read team.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Updates a team's name.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @param {string} name - New display name.
 * @returns {Promise<Envelope<{ team: TeamRow }>>} `{ success: true, team, status: 200 }`, `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function updateTeam(
  dbClient: DbClient,
  team_uuid: string,
  name: string
): Promise<Envelope<{ team: TeamRow }>> {
  const invalid = validateName(name)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const result = await dbClient.query(
      `UPDATE teams SET team_name = $2 WHERE team_uuid = $1 RETURNING ${TEAM_COLUMNS}`,
      [team_uuid, name.trim()]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Team not found.", status: 404 }
    }
    return { success: true, team: result.rows[0], status: 200 }
  } catch (error) {
    console.error("Error in updateTeam:", error)
    return {
      error: true,
      message: "Could not update team.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Permanently deletes a team. Its membership rows are removed by
 * `ON DELETE CASCADE`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} team_uuid - The team UUID.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, status: 404 }`, or an error envelope.
 */
export async function deleteTeam(
  dbClient: DbClient,
  team_uuid: string
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "DELETE FROM teams WHERE team_uuid = $1 RETURNING team_uuid",
      [team_uuid]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Team not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in deleteTeam:", error)
    return {
      error: true,
      message: "Could not delete team.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Lists every team in an organisation, ordered by name.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope<{ teams: TeamRow[] }>>} `{ success: true, teams, status: 200 }` or an error envelope.
 */
export async function listTeams(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ teams: TeamRow[] }>> {
  try {
    const result = await dbClient.query(
      `SELECT ${TEAM_COLUMNS} FROM teams WHERE org_uuid = $1 ORDER BY team_name ASC`,
      [org_uuid]
    )
    return { success: true, teams: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in listTeams:", error)
    return {
      error: true,
      message: "Could not list teams.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
