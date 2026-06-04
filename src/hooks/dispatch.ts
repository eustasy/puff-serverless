import type { EmitContext, HookEvent, HookOutcome } from "./types.js"
import { DEFAULT_SEVERITY, type EventType } from "./events.js"
import { getListeners } from "./registry.js"

// The shape handlers actually fill in. Severity defaults from the event
// type's tier; outcome defaults to "success"; every target field defaults
// to null. Pass only what the call site knows.
export interface EmitInput {
  event_type: EventType
  event_outcome?: HookOutcome
  event_severity?: HookEvent["event_severity"]
  actor_user_uuid?: string | null
  actor_ip?: string | null
  actor_user_agent?: string | null
  target_user_uuid?: string | null
  target_org_uuid?: string | null
  target_team_uuid?: string | null
  target_app_uuid?: string | null
  target_label?: string | null
  event_metadata?: Record<string, unknown> | null
}

function normalise(input: EmitInput): HookEvent {
  return {
    event_type: input.event_type,
    event_severity: input.event_severity ?? DEFAULT_SEVERITY[input.event_type] ?? "info",
    event_outcome: input.event_outcome ?? "success",
    actor_user_uuid: input.actor_user_uuid ?? null,
    actor_ip: input.actor_ip ?? null,
    actor_user_agent: input.actor_user_agent ?? null,
    target_user_uuid: input.target_user_uuid ?? null,
    target_org_uuid: input.target_org_uuid ?? null,
    target_team_uuid: input.target_team_uuid ?? null,
    target_app_uuid: input.target_app_uuid ?? null,
    target_label: input.target_label ?? null,
    event_metadata: input.event_metadata ?? null,
  }
}

/**
 * Dispatch an event to every registered listener.
 *
 * Sync listeners are awaited; if one throws, the exception propagates so
 * the caller can decide how to handle a failed audit write (typically:
 * surface a 500). Async listeners are queued via `ctx.waitUntil` and their
 * errors are caught and logged — they must never fail the response.
 *
 * `ctx` may be null when there is no Pages Function context available
 * (cron, scripts, tests). In that case async listeners still run, but
 * inline; the dispatcher does not wait for them.
 */
export async function emit(dbClient: DbClient, ctx: EmitContext | null, input: EmitInput): Promise<void> {
  const event = normalise(input)
  for (const listener of getListeners()) {
    if (listener.filter && !listener.filter(event)) continue

    if (listener.kind === "sync") {
      await listener.handle(dbClient, event)
      continue
    }

    const work = listener.handle(dbClient, event).catch((err: unknown) => {
      console.error(`Hook listener "${listener.name}" failed for event ${event.event_type}:`, err)
    })
    if (ctx) {
      ctx.waitUntil(work)
    }
  }
}

/**
 * Handler-friendly wrapper around `emit`. Pulls `dbClient`, `user_uuid`,
 * client IP and user-agent off the Pages Function context so callers only
 * need to specify what is event-specific.
 *
 * The actor defaults to `context.data.user_uuid` (set by
 * `functions/api/db/auth/_middleware.ts`); pass `actor_user_uuid: null`
 * explicitly for pre-auth events such as failed logins.
 */
export async function emitFromContext(context: EmitContext, input: EmitInput): Promise<void> {
  const dbClient = context.data.dbClient
  if (!dbClient) {
    console.error(`emitFromContext: dbClient missing on context for event ${input.event_type}; skipping audit.`)
    return
  }
  const headers = context.request.headers
  const enriched: EmitInput = {
    ...input,
    actor_user_uuid: input.actor_user_uuid !== undefined ? input.actor_user_uuid : (context.data.user_uuid ?? null),
    actor_ip: input.actor_ip ?? headers.get("CF-Connecting-IP"),
    actor_user_agent: input.actor_user_agent ?? headers.get("User-Agent"),
  }
  await emit(dbClient, context, enriched)
}
