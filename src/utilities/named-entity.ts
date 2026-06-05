// Shared CRUD primitives for the "named entity" domain modules — a UUID-keyed
// row with a display name, read by id and renamed in place (organisations,
// teams). `table`, `columns`, and the id/name columns are internal literals
// supplied by the caller's spec, never user input, so interpolating them into
// the SQL is safe.
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
  /** Message for the 404 when no row matches the id. */
  notFoundMessage: string
}

/** Reads one row by id, or the spec's 404 envelope when absent. */
export async function readNamedEntity<T>(
  dbClient: DbClient,
  spec: NamedEntitySpec,
  id: string,
  errorLabel: string,
  errorMessage: string
): Promise<Envelope<{ row: T }>> {
  try {
    const result = await dbClient.query(`SELECT ${spec.columns} FROM ${spec.table} WHERE ${spec.idColumn} = $1 LIMIT 1`, [id])
    if (result.rows.length === 0) {
      return { success: false, message: spec.notFoundMessage, status: 404 }
    }
    return { success: true, row: result.rows[0], status: 200 }
  } catch (error) {
    console.error(`Error in ${errorLabel}:`, error)
    return {
      error: true,
      message: errorMessage,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Renames one row by id (trimming `name`), or the spec's 404 envelope when absent. */
export async function updateNamedEntityName<T>(
  dbClient: DbClient,
  spec: NamedEntitySpec,
  id: string,
  name: string,
  errorLabel: string,
  errorMessage: string
): Promise<Envelope<{ row: T }>> {
  try {
    const result = await dbClient.query(`UPDATE ${spec.table} SET ${spec.nameColumn} = $2 WHERE ${spec.idColumn} = $1 RETURNING ${spec.columns}`, [
      id,
      name.trim(),
    ])
    if ((result.rowCount ?? 0) === 0) {
      return { success: false, message: spec.notFoundMessage, status: 404 }
    }
    return { success: true, row: result.rows[0], status: 200 }
  } catch (error) {
    console.error(`Error in ${errorLabel}:`, error)
    return {
      error: true,
      message: errorMessage,
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
