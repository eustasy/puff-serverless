import {
  htmlResponse,
  resultNegative,
  methodNotAllowed,
} from "../../../../../src/utilities/responses.js"
import { showSchedules } from "../../../../../src/schedules.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"

// Operator-only read-out of CockroachDB's scheduled jobs — chiefly the
// Row-Level TTL cleanup schedules declared in `sql/schedules.sql`. Lets an
// operator confirm the automated row reaping is configured and healthy
// without opening a SQL shell. Served at /api/db/auth/admin/schedules, under
// the operator-only gate in the admin middleware.

/** Render one cell, escaping DB-sourced text and showing a dash for null. */
function cell(value: string | null): string {
  return value ? escapeHtml(value) : "—"
}

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
        <td>${cell(schedule.label)}</td>
        <td>${cell(schedule.status)}</td>
        <td>${cell(schedule.recurrence)}</td>
        <td>${cell(schedule.next_run)}</td>
        <td>${cell(schedule.state)}</td>
        <td>${cell(schedule.owner)}</td>
        <td>${cell(schedule.created)}</td>
      </tr>`
    }
  } else {
    html += '<tr><td colspan="7">No schedules found.</td></tr>'
  }
  html += "</tbody></table>"

  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
