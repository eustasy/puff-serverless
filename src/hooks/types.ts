// Shape of an event passed to listeners. Field names mirror `audit_events`
// columns 1:1 so the default listener can persist without remapping.

export type HookSeverity = "debug" | "info" | "notice" | "warning" | "alert" | "critical"

export type HookOutcome = "success" | "failure" | "attempt"

export interface HookEvent {
  event_type: string
  event_severity: HookSeverity
  event_outcome: HookOutcome
  actor_user_uuid: string | null
  actor_ip: string | null
  actor_user_agent: string | null
  target_user_uuid: string | null
  target_org_uuid: string | null
  target_team_uuid: string | null
  target_app_uuid: string | null
  target_label: string | null
  // Free-form structured context. The audit listener JSON-encodes this for
  // storage; other listeners can pass it through as a real object.
  event_metadata: Record<string, unknown> | null
}

// A listener subscribes to events. `kind` decides whether the dispatcher
// awaits the listener (blocking the response) or runs it via `ctx.waitUntil`
// (best-effort, after the response is sent).
//
// `filter` is optional: when supplied, the listener only sees events for
// which `filter(event)` returns true.
export interface HookListener {
  name: string
  kind: "sync" | "async"
  filter?: (event: HookEvent) => boolean
  handle: (dbClient: DbClient, event: HookEvent) => Promise<void>
}

// Minimal structural view of a Pages Functions `EventContext` — just the
// pieces the dispatcher reads. Defined structurally so callers can pass
// the real context without an import dance.
export interface EmitContext {
  request: Request
  data: RequestData
  waitUntil(promise: Promise<unknown>): void
}
