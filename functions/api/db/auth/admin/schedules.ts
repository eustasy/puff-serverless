import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../../src/utilities/responses.js"
import { showSchedules } from "../../../../../src/schedules.js"
import { renderScheduleCell } from "../../../../../src/utilities/admin-schedules.js"

// Operator-only read-out of CockroachDB's scheduled jobs — chiefly the
// Row-Level TTL cleanup schedules declared in `sql/schedules.sql`. Lets an
// operator confirm the automated row reaping is configured and healthy
// without opening a SQL shell. Served at /api/db/auth/admin/schedules, under
// the operator-only gate in the admin middleware.

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!

  const result = await showSchedules(dbClient)
  if (!result.success) {
    return resultNegative(result.error, result.status)
  }

  let html = `<table><thead><tr>
      <th>Label</th>
      <th>Status</th>
      <th>Recurrence</th>
      <th>Next run</th>
      <th>State</th>
      <th>Owner</th>
      <th>Created</th>
    </tr></thead><tbody>`
  if (result.schedules.length > 0) {
    for (const schedule of result.schedules) {
      html += `<tr>
        <td>${renderScheduleCell(schedule.label)}</td>
        <td>${renderScheduleCell(schedule.status)}</td>
        <td>${renderScheduleCell(schedule.recurrence)}</td>
        <td>${renderScheduleCell(schedule.next_run)}</td>
        <td>${renderScheduleCell(schedule.state)}</td>
        <td>${renderScheduleCell(schedule.owner)}</td>
        <td>${renderScheduleCell(schedule.created)}</td>
      </tr>`
    }
  } else {
    html += '<tr><td colspan="7">No schedules found.</td></tr>'
  }
  html += "</tbody></table>"

  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
