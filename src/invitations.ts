// Organisation invitations (Phase 6).
//
// An invitation is a single-use, expiring token that grants its holder the
// offered organisation role(s) once accepted. Unlike a direct role grant it
// works before the invitee has an account — the email carries the link, the
// invitee signs in or registers, and `acceptInvitation` adds them.
//
// Invitations carry structured data (organisation, email, role set) that the
// generic `tokens` table has no columns for, so they get their own table with
// a real FK to `organisations` (`ON DELETE CASCADE` — deleting an organisation
// drops its pending invitations). Consumption is atomic, the same single-UPDATE
// pattern as `consumeToken`.

import { runInTransaction, Rollback } from "./utilities/transaction.js"
import { isOrgRole } from "./permissions.js"

// Invitations are valid for seven days.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

// SQLSTATE for a foreign-key violation — the organisation does not exist.
const FK_VIOLATION = "23503"

const INVITATION_COLUMNS = "invitation_token, org_uuid, email_address, roles, invited_by, created_at, expires_at, is_used"

/** An invitation joined with its organisation's display name. */
export interface InvitationDetail extends OrganisationInvitationRow {
  org_name: string
}

/**
 * Creates an organisation invitation. `roles` is the role set the invitee will
 * receive on acceptance — validated here so `acceptInvitation` can trust it.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The inviting organisation.
 * @param {string} email_address - The address the invitation is sent to.
 * @param {string[]} roles - Organisation roles to grant on acceptance.
 * @param {string | null} invited_by - UUID of the inviting user, or null.
 * @returns {Promise<Envelope<{ invitation: OrganisationInvitationRow }>>} `{ success: true, invitation, status: 201 }`, `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function createInvitation(
  dbClient: DbClient,
  org_uuid: string,
  email_address: string,
  roles: string[],
  invited_by: string | null
): Promise<Envelope<{ invitation: OrganisationInvitationRow }>> {
  if (typeof email_address !== "string" || email_address.trim() === "") {
    return {
      success: false,
      message: "An email address is required.",
      status: 400,
    }
  }
  const wanted = [...new Set(roles)]
  if (wanted.length === 0 || !wanted.every(isOrgRole)) {
    return {
      success: false,
      message: "One or more valid organisation roles are required.",
      status: 400,
    }
  }
  try {
    const invitation_token = crypto.randomUUID()
    const expires_at = new Date(Date.now() + INVITATION_TTL_MS).toISOString()
    const result = await dbClient.query(
      `INSERT INTO organisation_invitations (invitation_token, org_uuid, email_address, roles, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${INVITATION_COLUMNS}`,
      [invitation_token, org_uuid, email_address.trim(), wanted, invited_by, expires_at]
    )
    return { success: true, invitation: result.rows[0], status: 201 }
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      return { success: false, message: "Organisation not found.", status: 404 }
    }
    console.error("Error in createInvitation:", error)
    return {
      error: true,
      message: "Could not create invitation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reads an invitation by token, joined with the organisation's name, so the
 * accept page can show what is being offered. Returns the record whether or
 * not it is spent or expired — the caller inspects `is_used` / `expires_at`.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} token - The invitation token.
 * @returns {Promise<Envelope<{ invitation: InvitationDetail }>>} `{ success: true, invitation, status: 200 }`, `{ success: false, message, status: 404 }`, or an error envelope.
 */
export async function readInvitation(dbClient: DbClient, token: string): Promise<Envelope<{ invitation: InvitationDetail }>> {
  try {
    const result = await dbClient.query(
      `SELECT i.invitation_token, i.org_uuid, i.email_address, i.roles, i.invited_by,
              i.created_at, i.expires_at, i.is_used, o.org_name
       FROM organisation_invitations i
       JOIN organisations o ON o.org_uuid = i.org_uuid
       WHERE i.invitation_token = $1
       LIMIT 1`,
      [token]
    )
    if (result.rows.length === 0) {
      return { success: false, message: "Invitation not found.", status: 404 }
    }
    return { success: true, invitation: result.rows[0], status: 200 }
  } catch (error) {
    console.error("Error in readInvitation:", error)
    return {
      error: true,
      message: "Could not read invitation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Accepts an invitation on behalf of an authenticated user: atomically spends
 * the token, then grants the user every role the invitation carried, all in
 * one transaction. Possession of the token is the capability — the accepting
 * account need not own the invited address.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} token - The invitation token.
 * @param {string} user_uuid - The accepting (authenticated) user.
 * @returns {Promise<Envelope<{ org_uuid: string }>>} `{ success: true, org_uuid, status: 200 }`, `{ success: false, message, status: 400|404 }`, or an error envelope.
 */
export async function acceptInvitation(dbClient: DbClient, token: string, user_uuid: string): Promise<Envelope<{ org_uuid: string }>> {
  type Result = Envelope<{ org_uuid: string }>
  try {
    return await runInTransaction(dbClient, async (): Promise<Result> => {
      // Spend the invitation. The predicate collapses missing / expired /
      // already-used into one rowCount-0 outcome, so two concurrent accepts
      // of the same token cannot both proceed.
      const consumed = await dbClient.query(
        `UPDATE organisation_invitations SET is_used = TRUE
         WHERE invitation_token = $1 AND is_used = FALSE AND expires_at > NOW()
         RETURNING org_uuid, roles, invited_by`,
        [token]
      )
      if (consumed.rowCount === 0) {
        throw new Rollback<Result>({
          success: false,
          message: "This invitation is invalid, expired, or already used.",
          status: 400,
        })
      }
      const { org_uuid, roles, invited_by } = consumed.rows[0] as {
        org_uuid: string
        roles: string[]
        invited_by: string | null
      }
      for (const role of roles) {
        await dbClient.query(
          `INSERT INTO organisation_members (org_uuid, user_uuid, role, added_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_uuid, user_uuid, role) DO NOTHING`,
          [org_uuid, user_uuid, role, invited_by]
        )
      }
      return { success: true, org_uuid, status: 200 }
    })
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      return {
        success: false,
        message: "That organisation no longer exists.",
        status: 404,
      }
    }
    console.error("Error in acceptInvitation:", error)
    return {
      error: true,
      message: "Could not accept invitation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Lists an organisation's pending (unspent, unexpired) invitations.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation UUID.
 * @returns {Promise<Envelope<{ invitations: OrganisationInvitationRow[] }>>} `{ success: true, invitations, status: 200 }` or an error envelope.
 */
export async function listInvitations(
  dbClient: DbClient,
  org_uuid: string
): Promise<Envelope<{ invitations: OrganisationInvitationRow[] }>> {
  try {
    const result = await dbClient.query(
      `SELECT ${INVITATION_COLUMNS} FROM organisation_invitations
       WHERE org_uuid = $1 AND is_used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [org_uuid]
    )
    return { success: true, invitations: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in listInvitations:", error)
    return {
      error: true,
      message: "Could not list invitations.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Revokes (deletes) a pending invitation. Scoped to `org_uuid` so an
 * organisation can only revoke its own invitations.
 * @param {Client} dbClient - An active pg.Client instance.
 * @param {string} org_uuid - The organisation the invitation must belong to.
 * @param {string} token - The invitation token.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }`, `{ success: false, status: 404 }`, or an error envelope.
 */
export async function revokeInvitation(dbClient: DbClient, org_uuid: string, token: string): Promise<Envelope> {
  try {
    const result = await dbClient.query("DELETE FROM organisation_invitations WHERE invitation_token = $1 AND org_uuid = $2", [
      token,
      org_uuid,
    ])
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: "Invitation not found.", status: 404 }
    }
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in revokeInvitation:", error)
    return {
      error: true,
      message: "Could not revoke invitation.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
