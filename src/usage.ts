// Domain module for `usage_events` and `usage_rollups` — records per-event
// usage and aggregates it into daily rollups for billing reconciliation.
//
// `recordUsageEvent` is idempotency-safe: duplicate calls with the same
// (app_uuid, idempotency_key) pair are accepted as success rather than
// errors — the original event already landed.
//
// `recomputeUsageRollups` is fully idempotent: rerunning it for the same day
// overwrites the rollup quantity and clears `synced_at` only when the stored
// quantity actually changes, so the provider-sync step can detect stale rows
// without unnecessary re-pushes.

import type { BillingProvider } from "./billing.js"

interface RecordUsageEventInput {
  app_uuid: string
  org_uuid: string
  /** Optional — events can be app-level with no authenticated user. */
  user_uuid?: string | null
  metric: string
  quantity: number
  occurred_at: Date | string
  idempotency_key: string
}

/**
 * Insert one usage event into `usage_events`. Generates `event_uuid`
 * internally. Idempotency-safe: a duplicate `(app_uuid, idempotency_key)` is
 * silently treated as success — the caller already recorded the event.
 *
 * Does not emit audit events; the ingest endpoint handles that.
 */
export async function recordUsageEvent(dbClient: DbClient, input: RecordUsageEventInput): Promise<Envelope<{ event_uuid: string }>> {
  const { app_uuid, org_uuid, user_uuid, metric, quantity, idempotency_key } = input

  // --- Input validation ---
  if (!app_uuid) {
    return { success: false, message: "app_uuid is required.", status: 400 }
  }
  if (!org_uuid) {
    return { success: false, message: "org_uuid is required.", status: 400 }
  }
  if (!metric || metric.trim() === "") {
    return {
      success: false,
      message: "metric must be a non-empty string.",
      status: 400,
    }
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return {
      success: false,
      message: "quantity must be a finite non-negative number.",
      status: 400,
    }
  }
  if (!idempotency_key) {
    return {
      success: false,
      message: "idempotency_key is required.",
      status: 400,
    }
  }

  let occurred_at_parsed: Date
  if (input.occurred_at instanceof Date) {
    occurred_at_parsed = input.occurred_at
  } else {
    occurred_at_parsed = new Date(input.occurred_at)
  }
  if (isNaN(occurred_at_parsed.getTime())) {
    return {
      success: false,
      message: "occurred_at must be a valid date.",
      status: 400,
    }
  }

  try {
    const event_uuid = crypto.randomUUID()
    const query = `
      INSERT INTO usage_events (
        event_uuid, app_uuid, org_uuid, user_uuid,
        metric, quantity, occurred_at, idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (app_uuid, idempotency_key) DO NOTHING
      RETURNING event_uuid
    `
    const values = [event_uuid, app_uuid, org_uuid, user_uuid ?? null, metric, quantity, occurred_at_parsed, idempotency_key]

    const result = await dbClient.query(query, values)

    if ((result.rowCount ?? 0) === 0) {
      // Conflict: the event was already recorded on a previous attempt. Treat
      // as success and return the existing event's uuid (a one-off lookup on
      // the rare duplicate path) rather than a misleading placeholder.
      const existing = await dbClient.query(
        `SELECT event_uuid FROM usage_events
          WHERE app_uuid = $1 AND idempotency_key = $2 LIMIT 1`,
        [app_uuid, idempotency_key]
      )
      return {
        success: true,
        event_uuid: existing.rows[0]?.event_uuid ?? "",
        status: 200,
      }
    }

    return { success: true, event_uuid: result.rows[0].event_uuid, status: 201 }
  } catch (error) {
    console.error("Error in recordUsageEvent:", error)
    return {
      error: true,
      message: "Could not record usage event.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Aggregate `usage_events` for a single UTC calendar day into `usage_rollups`.
 * Grouped by `(app_uuid, org_uuid, metric)`, summing `quantity`.
 *
 * Fully idempotent: rerunning for the same day overwrites existing rows.
 * `synced_at` is set to NULL only when the stored quantity changes, so the
 * provider-sync step knows which rows need to be re-pushed.
 *
 * Does NOT call any billing provider API — that is a separate session's job.
 *
 * @param dbClient - Injected pg client from middleware.
 * @param day - The UTC date to aggregate. Accepts a `Date` or ISO date string
 *              (`"YYYY-MM-DD"`). Normalised to midnight UTC.
 */
export async function recomputeUsageRollups(dbClient: DbClient, day: Date | string): Promise<Envelope<{ upserted: number }>> {
  // Normalise to a UTC-date string ("YYYY-MM-DD") so CockroachDB's DATE
  // arithmetic is unambiguous regardless of JS's local timezone.
  let dayStr: string
  if (typeof day === "string") {
    // Accept "YYYY-MM-DD" or any ISO string; extract the date part only.
    dayStr = day.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
      return {
        success: false,
        message: "day must be a valid ISO date string (YYYY-MM-DD).",
        status: 400,
      }
    }
  } else {
    if (isNaN(day.getTime())) {
      return {
        success: false,
        message: "day must be a valid Date.",
        status: 400,
      }
    }
    // Format as YYYY-MM-DD in UTC.
    dayStr = day.toISOString().slice(0, 10)
  }

  try {
    // Aggregate events for the day window [dayStr 00:00:00 UTC, nextDay 00:00:00 UTC).
    // ON CONFLICT upserts the new sum and clears synced_at only when the
    // quantity actually changed, so unchanged rows are not re-pushed to the
    // billing provider.
    const query = `
      INSERT INTO usage_rollups (app_uuid, org_uuid, metric, day, quantity, synced_at)
      SELECT
        app_uuid,
        org_uuid,
        metric,
        $1::DATE AS day,
        SUM(quantity) AS quantity,
        NULL AS synced_at
      FROM usage_events
      WHERE occurred_at >= $1::DATE
        AND occurred_at <  $1::DATE + INTERVAL '1 day'
      GROUP BY app_uuid, org_uuid, metric
      ON CONFLICT (app_uuid, org_uuid, metric, day) DO UPDATE
        SET quantity  = excluded.quantity,
            synced_at = CASE
              WHEN usage_rollups.quantity = excluded.quantity
                THEN usage_rollups.synced_at
              ELSE NULL
            END
    `

    const result = await dbClient.query(query, [dayStr])
    return { success: true, upserted: result.rowCount ?? 0, status: 200 }
  } catch (error) {
    console.error("Error in recomputeUsageRollups:", error)
    return {
      error: true,
      message: "Could not recompute usage rollups.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Operator view: recent usage rollups across all orgs/apps, most recent day
 * first. Optionally filtered by org. For the admin usage dashboard.
 */
export async function listUsageRollups(
  dbClient: DbClient,
  opts: { limit?: number; org_uuid?: string } = {}
): Promise<Envelope<{ rollups: UsageRollupRow[] }>> {
  const limit = opts.limit ?? 500
  try {
    const { rows } = opts.org_uuid
      ? await dbClient.query(
          `SELECT app_uuid, org_uuid, metric, day, quantity, synced_at
             FROM usage_rollups WHERE org_uuid = $1
            ORDER BY day DESC, app_uuid ASC LIMIT $2`,
          [opts.org_uuid, limit]
        )
      : await dbClient.query(
          `SELECT app_uuid, org_uuid, metric, day, quantity, synced_at
             FROM usage_rollups
            ORDER BY day DESC, app_uuid ASC LIMIT $1`,
          [limit]
        )
    return { success: true, rollups: rows, status: 200 }
  } catch (error) {
    console.error("Error in listUsageRollups:", error)
    return {
      error: true,
      message: "Could not list usage rollups.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Pushes not-yet-synced rollups to the billing provider as metered usage and
 * marks each `synced_at` on success. Idempotent: a unique `identifier` per
 * `(app, org, metric, day)` lets the provider dedupe, and a row whose push
 * fails is simply left unsynced for the next run. Returns the count synced.
 */
export async function syncUsageRollups(
  dbClient: DbClient,
  provider: BillingProvider,
  opts: { limit?: number } = {}
): Promise<Envelope<{ synced: number }>> {
  const limit = opts.limit ?? 500
  try {
    const { rows } = await dbClient.query(
      `SELECT r.app_uuid, r.org_uuid, r.metric, r.day, r.quantity,
              c.provider_customer_id
         FROM usage_rollups r
         JOIN billing_customers c ON c.org_uuid = r.org_uuid
        WHERE r.synced_at IS NULL
        ORDER BY r.day ASC
        LIMIT $1`,
      [limit]
    )

    let synced = 0
    for (const row of rows) {
      const dayStr = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10)
      try {
        await provider.recordMeterEvent({
          eventName: row.metric,
          customerId: row.provider_customer_id,
          value: Number(row.quantity),
          identifier: `${row.app_uuid}:${row.org_uuid}:${row.metric}:${dayStr}`,
        })
        await dbClient.query(
          `UPDATE usage_rollups SET synced_at = now()
            WHERE app_uuid = $1 AND org_uuid = $2 AND metric = $3 AND day = $4`,
          [row.app_uuid, row.org_uuid, row.metric, row.day]
        )
        synced++
      } catch (pushError) {
        // Leave the row unsynced; the next run retries it.
        console.error(`syncUsageRollups: failed to push ${row.app_uuid}/${row.org_uuid}/${row.metric}/${dayStr}:`, pushError)
      }
    }

    return { success: true, synced, status: 200 }
  } catch (error) {
    console.error("Error in syncUsageRollups:", error)
    return {
      error: true,
      message: "Could not sync usage rollups.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
