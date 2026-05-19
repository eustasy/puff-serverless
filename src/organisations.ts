// Organisations — the top-level multi-tenant entity (Phase 6).
//
// Every function takes `dbClient` first and returns the standard Envelope. A
// user's relationship to an organisation is the set of role grants in
// `organisation_members` (see src/memberships.ts); creating an organisation
// makes the creator its first `owner`.

import { runInTransaction, Rollback } from "./utilities/transaction.js"
import { OWNER_ROLE } from "./permissions.js"

/** Longest accepted organisation display name. */
export const MAX_NAME_LENGTH = 128
/** Longest accepted URL slug. */
export const MAX_SLUG_LENGTH = 64

// A slug is one or more lowercase alphanumeric segments joined by single
// hyphens — safe to place in a URL path without escaping.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// SQLSTATE for a unique-constraint violation — a slug collision on UPDATE,
// where ON CONFLICT does not apply.
const UNIQUE_VIOLATION = "23505"

const ORG_COLUMNS =
  "org_uuid, org_name, org_slug, org_active, org_created_at, org_created_by"

/** Validates an organisation name + slug. Returns an error message, or null. */
function validateInput(name: string, slug: string): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return "An organisation name is required."
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return `Names cannot be longer than ${MAX_NAME_LENGTH} characters.`
  }
  if (
    typeof slug !== "string" ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    return "A URL slug of lowercase letters, numbers and hyphens is required."
  }
  return null
}

/**
 * Creates an organisation and makes the creator its first `owner`, in one
 * transaction. The slug must be unique across all organisations.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} name - Display name.
 * @param {string} slug - URL-safe slug (lowercase alphanumeric + hyphens).
 * @param {string} creator_uuid - UUID of the user creating the organisation.
 * @returns {Promise<Envelope<{ organisation: OrganisationRow }>>} `{ success: true, organisation, status: 201 }`, `{ success: false, message, status: 400|409 }`, or an error envelope.
 */
export async function createOrganisation(
  dbClient: DbClient,
  name: string,
  slug: string,
  creator_uuid: string
): Promise<Envelope<{ organisation: OrganisationRow }>> {
  const invalid = validateInput(name, slug)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  type Result = Envelope<{ organisation: OrganisationRow }>
  try {
    const org_uuid = crypto.randomUUID()
    return await runInTransaction(dbClient, async (): Promise<Result> => {
      const insert = await dbClient.query(
        `INSERT INTO organisations (org_uuid, org_name, org_slug, org_created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_slug) DO NOTHING
         RETURNING ${ORG_COLUMNS}`,
        [org_uuid, name.trim(), slug, creator_uuid]
      )
      if (insert.rowCount === 0) {
        throw new Rollback<Result>({
          success: false,
          message: "That organisation URL is already taken.",
          status: 409,
        })
      }
      // The creator is the first owner; they added themselves.
      await dbClient.query(
        "INSERT INTO organisation_members (org_uuid, user_uuid, role, added_by) VALUES ($1, $2, $3, $2)",
        [org_uuid, creator_uuid, OWNER_ROLE]
      )
      return { success: true, organisation: insert.rows[0], status: 201 }
    })
  } catch (error) {
    console.error("Error in createOrganisation:", error)
    return {
      error: true,
      message: "Could not create organisation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reads an organisation by UUID. Returns the record whether or not it is
 * active, so callers (e.g. a re-enable flow) can act on a disabled org.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope<{ organisation: OrganisationRow }>>} `{ success: true, organisation, status: 200 }`, `{ success: false, message, status: 404 }`, or an error envelope.
 */
export async function readOrganisation(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ organisation: OrganisationRow }>> {
  try {
    const result = await dbClient.query(
      `SELECT ${ORG_COLUMNS} FROM organisations WHERE org_uuid = $1 LIMIT 1`,
      [org_uuid]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    return { success: true, organisation: result.rows[0], status: 200 }
  } catch (error) {
    console.error("Error in readOrganisation:", error)
    return {
      error: true,
      message: "Could not read organisation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Updates an organisation's name and slug.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @param {string} name - New display name.
 * @param {string} slug - New URL-safe slug.
 * @returns {Promise<Envelope<{ organisation: OrganisationRow }>>} `{ success: true, organisation, status: 200 }`, `{ success: false, message, status: 400|404|409 }`, or an error envelope.
 */
export async function updateOrganisation(
  dbClient: DbClient,
  org_uuid: string,
  name: string,
  slug: string
): Promise<Envelope<{ organisation: OrganisationRow }>> {
  const invalid = validateInput(name, slug)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const result = await dbClient.query(
      `UPDATE organisations SET org_name = $2, org_slug = $3 WHERE org_uuid = $1 RETURNING ${ORG_COLUMNS}`,
      [org_uuid, name.trim(), slug]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    return { success: true, organisation: result.rows[0], status: 200 }
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return {
        success: false,
        message: "That organisation URL is already taken.",
        status: 409,
      }
    }
    console.error("Error in updateOrganisation:", error)
    return {
      error: true,
      message: "Could not update organisation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Flips `org_active`. Shared by disableOrganisation / enableOrganisation. */
async function setOrganisationActive(
  dbClient: DbClient,
  org_uuid: string,
  active: boolean
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "UPDATE organisations SET org_active = $2 WHERE org_uuid = $1 RETURNING org_uuid",
      [org_uuid, active]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in setOrganisationActive:", error)
    return {
      error: true,
      message: "Could not update organisation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Disables an organisation (reversible — see `enableOrganisation`). Memberships
 * are kept; access is gated on `org_active` at the request layer.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, status: 404 }`, or an error envelope.
 */
export async function disableOrganisation(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope> {
  return setOrganisationActive(dbClient, org_uuid, false)
}

/**
 * Re-enables a disabled organisation. Idempotent.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, status: 404 }`, or an error envelope.
 */
export async function enableOrganisation(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope> {
  return setOrganisationActive(dbClient, org_uuid, true)
}

/**
 * Permanently deletes an organisation. Its teams and every membership row are
 * removed by `ON DELETE CASCADE`. Irreversible — use `disableOrganisation` for
 * anything reversible.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, status: 404 }`, or an error envelope.
 */
export async function deleteOrganisation(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope> {
  try {
    const result = await dbClient.query(
      "DELETE FROM organisations WHERE org_uuid = $1 RETURNING org_uuid",
      [org_uuid]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in deleteOrganisation:", error)
    return {
      error: true,
      message: "Could not delete organisation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** An organisation plus the roles the queried user holds in it. */
export interface OrganisationWithRoles extends OrganisationRow {
  roles: string[]
}

/**
 * Lists the organisations a user is a member of (holds at least one
 * organisation-scoped role in), each with that user's roles.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} user_uuid - The user UUID.
 * @returns {Promise<Envelope<{ organisations: OrganisationWithRoles[] }>>} `{ success: true, organisations, status: 200 }` or an error envelope.
 */
export async function listOrganisationsForUser(
  dbClient: DbClient,
  user_uuid: string
): Promise<Envelope<{ organisations: OrganisationWithRoles[] }>> {
  try {
    const result = await dbClient.query(
      `SELECT o.org_uuid, o.org_name, o.org_slug, o.org_active, o.org_created_at, o.org_created_by,
              array_agg(m.role ORDER BY m.role) AS roles
       FROM organisations o
       JOIN organisation_members m ON m.org_uuid = o.org_uuid
       WHERE m.user_uuid = $1
       GROUP BY o.org_uuid, o.org_name, o.org_slug, o.org_active, o.org_created_at, o.org_created_by
       ORDER BY o.org_name ASC`,
      [user_uuid]
    )
    return { success: true, organisations: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in listOrganisationsForUser:", error)
    return {
      error: true,
      message: "Could not list organisations.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
