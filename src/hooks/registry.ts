import type { HookListener } from "./types.js"
import { auditListener } from "./listeners/audit.js"

// Listener registry. Adding a new listener = add an import + push it here.
// No runtime registration API — listeners are static per Worker invocation,
// matching the rest of the codebase's "no module-level mutable state across
// requests" posture.
//
// The audit listener must come first: its `kind: "sync"` guarantees the
// audit row exists before the dispatcher moves on to async listeners that
// may depend on it (e.g. a future webhook listener that includes the
// `event_uuid` in its payload).

const listeners: HookListener[] = [auditListener]

/** Returns the static listener list for the hook dispatcher. */
export function getListeners(): readonly HookListener[] {
  return listeners
}
