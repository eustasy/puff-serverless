// Shared helpers for the org-scoped entitlement endpoints. Entitlements are
// regular KV rows owned by an `apps` row, so the underlying storage is the
// same as any other KV; what differs is the allowed key namespace and the
// "grantee belongs to the granting org" check.

import { LICENSE_TIER_KEY, PERM_PREFIX } from "../apps.js"
import { parseSetForm, parseKeyForm } from "./keyvalues-endpoint.js"
import { resultNegative } from "./responses.js"

export { parseSetForm, parseKeyForm }

/**
 * Validates an entitlement key against the reserved namespace. Only
 * `license:tier` and `perm:<name>` are accepted from the entitlement
 * endpoints — `license:floating:max` and `license:tiers:*` / `license:perms:*`
 * are app-declared and managed via separate endpoints (`pool` for the
 * floating max; the app-self-owned tier/perm declarations are operator-only
 * for now).
 *
 * Returns `null` when valid; a `Response` with a 400 fragment otherwise.
 */
export function validateEntitlementKey(key: string): Response | null {
  if (key === LICENSE_TIER_KEY) return null
  if (key.startsWith(PERM_PREFIX) && key.length > PERM_PREFIX.length) {
    return null
  }
  return resultNegative(`Entitlement key must be "${LICENSE_TIER_KEY}" or start with "${PERM_PREFIX}".`, 400)
}
