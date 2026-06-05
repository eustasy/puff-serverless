// Shared CRUD primitives for the "named entity" domain modules — a UUID-keyed
// row with a display name, read by id and renamed in place (organisations,
// teams). `table`, `columns`, and the id/name columns are internal literals
// supplied by the caller's spec, never user input, so interpolating them into
// the SQL is safe. All user-facing messages derive from the spec's `noun`.
//
// Only the genuinely-parallel read/rename paths live here. Create and delete
// diverge per entity (organisations open a transaction to seat the first owner
// and refuse deletion with an outstanding balance; teams do neither), so those
// stay in their own modules.

export interface NamedEntitySpec {
  table: string
  /** SELECT / RETURNING column list. */
  columns: string
  idColumn: string
  nameColumn: string
  /** Lowercase noun driving all messages, e.g. "organisation" | "team". */
  noun: string
  /** Validates a proposed display name; returns an error message, or null when valid. */
  validateName: (name: string) => string | null
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Reads one row by id, or the spec's 404 envelope when absent. */
export async function readNamedEntity<T>(dbClient: DbClient, spec: NamedEntitySpec, id: string): Promise<Envelope<{ row: T }>> {
  try {
    const result = await dbClient.query(`SELECT ${spec.columns} FROM ${spec.table} WHERE ${spec.idColumn} = $1 LIMIT 1`, [id])
    if (result.rows.length === 0) {
      return { success: false, message: `${capitalise(spec.noun)} not found.`, status: 404 }
    }
    return { success: true, row: result.rows[0], status: 200 }
  } catch (error) {
    console.error(`Error in readNamedEntity (${spec.noun}):`, error)
    return {
      error: true,
      message: `Could not read ${spec.noun}.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Validates `name` via the spec, then renames one row by id (trimming `name`).
 * Returns a 400 on invalid input, the spec's 404 when no row matches, or the
 * updated row.
 */
export async function updateNamedEntityName<T>(
  dbClient: DbClient,
  spec: NamedEntitySpec,
  id: string,
  name: string
): Promise<Envelope<{ row: T }>> {
  const invalid = spec.validateName(name)
  if (invalid) {
    return { success: false, message: invalid, status: 400 }
  }
  try {
    const result = await dbClient.query(
      `UPDATE ${spec.table} SET ${spec.nameColumn} = $2 WHERE ${spec.idColumn} = $1 RETURNING ${spec.columns}`,
      [id, name.trim()]
    )
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: `${capitalise(spec.noun)} not found.`, status: 404 }
    }
    return { success: true, row: result.rows[0], status: 200 }
  } catch (error) {
    console.error(`Error in updateNamedEntityName (${spec.noun}):`, error)
    return {
      error: true,
      message: `Could not update ${spec.noun}.`,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
