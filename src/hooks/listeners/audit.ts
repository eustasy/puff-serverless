import type { HookEvent, HookListener } from "../types.js"

// Synchronous, append-only writer to the `audit_events` table. This is the
// default listener and the reason the hooks system exists: if this INSERT
// fails, the dispatcher lets the exception propagate so the request fails
// loudly rather than silently losing the audit row.

async function handle(dbClient: DbClient, event: HookEvent): Promise<void> {
  const event_uuid = crypto.randomUUID()
  const event_metadata = event.event_metadata === null ? null : JSON.stringify(event.event_metadata)

  await dbClient.query(
    `INSERT INTO audit_events (
       event_uuid, event_type, event_severity, event_outcome,
       actor_user_uuid, actor_ip, actor_user_agent,
       target_user_uuid, target_org_uuid, target_team_uuid, target_app_uuid,
       target_label, event_metadata
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13
     )`,
    [
      event_uuid,
      event.event_type,
      event.event_severity,
      event.event_outcome,
      event.actor_user_uuid,
      event.actor_ip,
      event.actor_user_agent,
      event.target_user_uuid,
      event.target_org_uuid,
      event.target_team_uuid,
      event.target_app_uuid,
      event.target_label,
      event_metadata,
    ]
  )
}

export const auditListener: HookListener = {
  name: "audit",
  kind: "sync",
  handle,
}
