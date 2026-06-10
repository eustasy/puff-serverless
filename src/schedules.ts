// Read-only view over CockroachDB's scheduled jobs.
//
// The pure-SQL row cleanup described in `sql/schedules.sql` runs as
// CockroachDB Row-Level TTL schedules — one per table — with no Worker
// involvement. `showSchedules` lets an operator confirm those schedules
// exist and are healthy without opening a SQL shell. It is surfaced by the
// operator-only endpoint `/api/admin/schedules`.
//
// Like every other `src/` module it takes `dbClient` as its first parameter
// and returns a structured envelope rather than throwing or returning raw
// rows.

/** One row of `SHOW SCHEDULES`, normalised for rendering. */
export interface ScheduleSummary {
  id: string
  label: string
  status: string
  next_run: string | null
  state: string | null
  recurrence: string | null
  owner: string | null
  created: string | null
}

/** Coerce a `SHOW SCHEDULES` cell to a trimmed string, or null when absent. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

/** Coerce a timestamp cell to an ISO string, or null when absent/invalid. */
function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = new Date(value as string | number | Date)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Lists every schedule CockroachDB knows about — most notably the Row-Level
 * TTL cleanup schedules declared in `sql/schedules.sql`.
 *
 * `SHOW SCHEDULES` cannot take bind parameters, so it is wrapped in a CTE
 * with a fixed projection; there is no user input in the query.
 *
 * @param {DbClient} dbClient - An active, connected pg client.
 * @returns the schedules on success, or an `error` message and `status`.
 */
export async function showSchedules(
  dbClient: DbClient
): Promise<{ success: true; error?: never; schedules: ScheduleSummary[] } | { success?: never; error: string; status: number }> {
  try {
    const result = await dbClient.query(
      `WITH s AS (SHOW SCHEDULES)
       SELECT id, label, schedule_status, next_run, state, recurrence, owner, created
         FROM s
        ORDER BY label, id`
    )

    const schedules: ScheduleSummary[] = result.rows.map((row) => {
      const r = row as Record<string, unknown>
      return {
        id: asText(r.id) ?? "",
        label: asText(r.label) ?? "",
        status: asText(r.schedule_status) ?? "",
        next_run: asIso(r.next_run),
        state: asText(r.state),
        recurrence: asText(r.recurrence),
        owner: asText(r.owner),
        created: asIso(r.created),
      }
    })

    return { success: true, schedules }
  } catch (error) {
    console.error("Error listing database schedules:", error)
    return {
      error: "Failed to list database schedules. The database user may lack the " + "privilege required to run SHOW SCHEDULES.",
      status: 500,
    }
  }
}
