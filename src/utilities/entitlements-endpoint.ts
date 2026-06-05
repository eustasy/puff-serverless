// Shared helpers for the org-scoped entitlement endpoints. Entitlements are
// regular KV rows owned by an `apps` row, so the underlying storage is the
// same as any other KV; what differs is the allowed key namespace and the
// "grantee belongs to the granting org" check.

import { LICENSE_TIER_KEY, PERM_PREFIX } from "../apps.js"
import { assertGranteeInOrg } from "../entitlements.js"
import { can } from "../permissions.js"
import { parseSetForm, parseKeyForm, renderKeyValueTable } from "./keyvalues-endpoint.js"
import type { Owner } from "./keyvalues-shared.js"
import { resultNegative, resultPositive, methodNotAllowed } from "./responses.js"
import { emitFromContext } from "../hooks/dispatch.js"
import type { EventType } from "../hooks/events.js"

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

// ── Grantee entitlement endpoint factories ──────────────────────────────────
// Eliminates the team/user handler duplication. The org-entitlements variants
// are structurally different (no assertGranteeInOrg, org is its own grantee)
// and are not covered here.

type KvPair = { kv_key: string; kv_value: string }

type GranteeKv = {
  readKeyValues(dbClient: DbClient, subject_uuid: string, owner: Owner): Promise<Envelope<{ pairs: KvPair[] }>>
  searchKeyValues(dbClient: DbClient, subject_uuid: string, owner: Owner, pattern: string): Promise<Envelope<{ pairs: KvPair[] }>>
  setKeyValue(dbClient: DbClient, subject_uuid: string, owner: Owner, key: string, value: string): Promise<Envelope<{ created: boolean }>>
  deleteKeyValue(dbClient: DbClient, subject_uuid: string, owner: Owner, key: string): Promise<Envelope>
}

type GranteeListConfig = {
  kv: Pick<GranteeKv, "readKeyValues" | "searchKeyValues">
  paramName: "team_uuid" | "user_uuid"
  granteeType: "team" | "user"
  urlSegment: "teams" | "users"
}

type GranteeSetConfig = {
  kv: Pick<GranteeKv, "setKeyValue">
  paramName: "team_uuid" | "user_uuid"
  granteeType: "team" | "user"
  eventType: EventType
}

type GranteeRemoveConfig = {
  kv: Pick<GranteeKv, "deleteKeyValue">
  paramName: "team_uuid" | "user_uuid"
  granteeType: "team" | "user"
  eventType: EventType
}

export function createGranteeEntitlementListHandler(config: GranteeListConfig): {
  onRequestGet: Handler
  onRequest: Handler
} {
  return {
    onRequestGet: async (context) => {
      const orgRoles = context.data.orgRoles ?? []
      if (!can(orgRoles, "org:entitlements:read")) {
        return resultNegative("You cannot view this data.", 403)
      }
      const app = context.data.app!
      const org_uuid = String(context.params.org_uuid)
      const grantee_uuid = String(context.params[config.paramName])
      const grantee =
        config.granteeType === "team"
          ? { type: "team" as const, team_uuid: grantee_uuid }
          : { type: "user" as const, user_uuid: grantee_uuid }
      const inOrg = await assertGranteeInOrg(context.data.dbClient!, org_uuid, grantee)
      if (!inOrg.success) {
        return resultNegative(inOrg.message, inOrg.status)
      }
      const owner = { type: "app" as const, app_uuid: app.app_uuid }
      const url = new URL(context.request.url)
      const search = (url.searchParams.get("key") ?? "").trim()
      const result = search
        ? await config.kv.searchKeyValues(context.data.dbClient!, grantee_uuid, owner, search)
        : await config.kv.readKeyValues(context.data.dbClient!, grantee_uuid, owner)
      if (!result.success) {
        return resultNegative(result.message, result.status)
      }
      return renderKeyValueTable(result.pairs, {
        removeBase: `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}/apps/${encodeURIComponent(app.app_uuid)}/${config.urlSegment}/${encodeURIComponent(grantee_uuid)}/entitlements/remove`,
        triggerName: "appEntitlementsChanged",
        canWrite: can(orgRoles, "org:entitlements:write"),
        search: search || undefined,
      })
    },
    onRequest: async () => methodNotAllowed("GET"),
  }
}

export function createGranteeEntitlementSetHandler(config: GranteeSetConfig): {
  onRequestPost: Handler
  onRequest: Handler
} {
  return {
    onRequestPost: async (context) => {
      const orgRoles = context.data.orgRoles ?? []
      if (!can(orgRoles, "org:entitlements:write")) {
        return resultNegative("You cannot modify this data.", 403)
      }
      const parsed = await parseSetForm(context.request)
      if (parsed instanceof Response) return parsed
      const keyErr = validateEntitlementKey(parsed.key)
      if (keyErr) return keyErr
      const org_uuid = String(context.params.org_uuid)
      const grantee_uuid = String(context.params[config.paramName])
      const app = context.data.app!
      const grantee =
        config.granteeType === "team"
          ? { type: "team" as const, team_uuid: grantee_uuid }
          : { type: "user" as const, user_uuid: grantee_uuid }
      const inOrg = await assertGranteeInOrg(context.data.dbClient!, org_uuid, grantee)
      if (!inOrg.success) {
        return resultNegative(inOrg.message, inOrg.status)
      }
      const result = await config.kv.setKeyValue(
        context.data.dbClient!,
        grantee_uuid,
        { type: "app", app_uuid: app.app_uuid },
        parsed.key,
        parsed.value
      )
      if (!result.success) {
        return resultNegative(result.message, result.status)
      }
      await emitFromContext(context, {
        event_type: config.eventType,
        target_org_uuid: org_uuid,
        target_team_uuid: config.granteeType === "team" ? grantee_uuid : undefined,
        target_user_uuid: config.granteeType === "user" ? grantee_uuid : undefined,
        target_app_uuid: app.app_uuid,
        target_label: parsed.key,
        event_metadata: { value: parsed.value, created: result.created },
      })
      return resultPositive(`Entitlement "${parsed.key}" ${result.created ? "granted" : "updated"}.`, result.status, {
        "HX-Trigger": "appEntitlementsChanged",
      })
    },
    onRequest: async () => methodNotAllowed("POST"),
  }
}

export function createGranteeEntitlementRemoveHandler(config: GranteeRemoveConfig): {
  onRequestPost: Handler
  onRequest: Handler
} {
  return {
    onRequestPost: async (context) => {
      const orgRoles = context.data.orgRoles ?? []
      if (!can(orgRoles, "org:entitlements:write")) {
        return resultNegative("You cannot modify this data.", 403)
      }
      const parsed = await parseKeyForm(context.request)
      if (parsed instanceof Response) return parsed
      const org_uuid = String(context.params.org_uuid)
      const grantee_uuid = String(context.params[config.paramName])
      const app = context.data.app!
      const grantee =
        config.granteeType === "team"
          ? { type: "team" as const, team_uuid: grantee_uuid }
          : { type: "user" as const, user_uuid: grantee_uuid }
      const inOrg = await assertGranteeInOrg(context.data.dbClient!, org_uuid, grantee)
      if (!inOrg.success) {
        return resultNegative(inOrg.message, inOrg.status)
      }
      const result = await config.kv.deleteKeyValue(
        context.data.dbClient!,
        grantee_uuid,
        { type: "app", app_uuid: app.app_uuid },
        parsed.key
      )
      if (!result.success) {
        return resultNegative(result.message, result.status)
      }
      await emitFromContext(context, {
        event_type: config.eventType,
        target_org_uuid: org_uuid,
        target_team_uuid: config.granteeType === "team" ? grantee_uuid : undefined,
        target_user_uuid: config.granteeType === "user" ? grantee_uuid : undefined,
        target_app_uuid: app.app_uuid,
        target_label: parsed.key,
      })
      return resultPositive(`Entitlement "${parsed.key}" revoked.`, result.status, {
        "HX-Trigger": "appEntitlementsChanged",
      })
    },
    onRequest: async () => methodNotAllowed("POST"),
  }
}
