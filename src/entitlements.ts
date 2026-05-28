// Entitlements — the read side of the app-permission model. Apps declare a
// licensing mode (`none` / `seat` / `usage` / `floating`); orgs grant
// entitlements as KV rows under the app's owner namespace; the OAuth layer
// asks "is this user licensed for this app in this org?" at token-issue time
// and "what entitlements should I bake into the access token / claims?" at
// claim-emit time.
//
// The KV store is the source of truth for everything except floating seats —
// those live in `app_floating_sessions` because their state changes per
// request (allocate / heartbeat / release), which a KV table cannot model.

import {
  LICENSE_PERMS_PREFIX,
  LICENSE_TIER_KEY,
  PERM_PREFIX,
  type AppLicensingMode,
} from "./apps.js"
import { resolveKeyValue } from "./keyvalues-resolver.js"
import { listAppPermissions } from "./apps.js"
import { ENTITLED_STATUSES, getSubscriptionForApp } from "./billing.js"

// --- Grantee-in-org constraint --------------------------------------------

/**
 * True if the user holds at least one `organisation_members` row in this org.
 * The role does not matter — a guest still counts; this is the
 * "are they attached to this org at all" check.
 */
export async function isUserInOrg(
  dbClient: DbClient,
  org_uuid: string,
  user_uuid: string
): Promise<Envelope<{ member: boolean }>> {
  try {
    const { rowCount } = await dbClient.query(
      `SELECT 1 FROM organisation_members
        WHERE org_uuid = $1 AND user_uuid = $2 LIMIT 1`,
      [org_uuid, user_uuid]
    )
    return { success: true, member: (rowCount ?? 0) > 0, status: 200 }
  } catch (error) {
    console.error("Error in isUserInOrg:", error)
    return {
      error: true,
      message: "Could not check organisation membership.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** True if `team_uuid` belongs to `org_uuid`. */
export async function isTeamInOrg(
  dbClient: DbClient,
  org_uuid: string,
  team_uuid: string
): Promise<Envelope<{ belongs: boolean }>> {
  try {
    const { rowCount } = await dbClient.query(
      `SELECT 1 FROM teams WHERE team_uuid = $1 AND org_uuid = $2 LIMIT 1`,
      [team_uuid, org_uuid]
    )
    return { success: true, belongs: (rowCount ?? 0) > 0, status: 200 }
  } catch (error) {
    console.error("Error in isTeamInOrg:", error)
    return {
      error: true,
      message: "Could not check team membership.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Asserts the grantee subject (a user or team) belongs to the granting org.
 * Apps are global, so the constraint is "grantee belongs to the org the
 * admin is acting within" — never "grantee belongs to the app". Returns a
 * not-found envelope on a violation so the caller can map it to a 404.
 */
export async function assertGranteeInOrg(
  dbClient: DbClient,
  org_uuid: string,
  grantee:
    | { type: "user"; user_uuid: string }
    | { type: "team"; team_uuid: string }
): Promise<Envelope> {
  if (grantee.type === "user") {
    const check = await isUserInOrg(dbClient, org_uuid, grantee.user_uuid)
    if (!check.success) return check
    if (!check.member) {
      return {
        success: false,
        message: "That user is not a member of this organisation.",
        status: 404,
      }
    }
    return { success: true, status: 200 }
  }
  const check = await isTeamInOrg(dbClient, org_uuid, grantee.team_uuid)
  if (!check.success) return check
  if (!check.belongs) {
    return {
      success: false,
      message: "That team does not belong to this organisation.",
      status: 404,
    }
  }
  return { success: true, status: 200 }
}

// --- "Is licensed" --------------------------------------------------------

/**
 * Resolves whether a user is licensed for `(app, org)` under the app's
 * declared licensing mode.
 *
 * For every mode except `none`, the org must first hold an active or trialing
 * subscription for the app (see `billing.ts`). Billing is payment-up-front
 * with zero grace: a `past_due` / `canceled` / `paused` / `incomplete`
 * subscription — or no subscription row at all — makes the app unlicensed
 * regardless of any granted entitlements. There is no implicit free tier;
 * `none` is the only mode that is free.
 *
 * Once the subscription gate passes, the per-user answer depends on the mode:
 *
 *   none      — always true; the app does not gate on licenses or billing.
 *   seat      — true if `license:tier` resolves to a value for the user
 *               under the app's owner namespace (most-specific tier wins via
 *               the standard KV resolver chain).
 *   usage     — true if the user is a member of the org; the app meters
 *               usage out of band, the count of users with at least one
 *               entitlement row drives the bill.
 *   floating  — true if `app_floating_sessions` has a row for the triple.
 *               This is a read-only check — allocation happens separately,
 *               via `checkoutFloatingSeat` at OAuth-token issue time.
 */
export async function isLicensed(
  dbClient: DbClient,
  app: { app_uuid: string; app_licensing_mode: AppLicensingMode },
  user_uuid: string,
  org_uuid: string
): Promise<Envelope<{ licensed: boolean; tier: string | null }>> {
  try {
    if (app.app_licensing_mode === "none") {
      return { success: true, licensed: true, tier: null, status: 200 }
    }

    // Billed modes require the org to hold an active/trialing subscription for
    // the app before any per-user entitlement is honoured. No grace window,
    // no implicit free tier.
    const subscription = await getSubscriptionForApp(
      dbClient,
      org_uuid,
      app.app_uuid
    )
    if (!subscription.success) return subscription
    if (
      !subscription.subscription ||
      !ENTITLED_STATUSES.includes(subscription.subscription.status)
    ) {
      return { success: true, licensed: false, tier: null, status: 200 }
    }

    if (app.app_licensing_mode === "usage") {
      const member = await isUserInOrg(dbClient, org_uuid, user_uuid)
      if (!member.success) return member
      return {
        success: true,
        licensed: member.member,
        tier: null,
        status: 200,
      }
    }

    if (app.app_licensing_mode === "seat") {
      const resolved = await resolveKeyValue(dbClient, {
        owner: { type: "app", app_uuid: app.app_uuid },
        key: LICENSE_TIER_KEY,
        user_uuid,
        org_uuid,
      })
      if (!resolved.success) return resolved
      if (resolved.values.length === 0) {
        return { success: true, licensed: false, tier: null, status: 200 }
      }
      // Resolver returns the most-specific tier; if the role tier produced
      // several values, picking the first is deterministic but somewhat
      // arbitrary. Apps that need multi-tier per user should expose that as
      // separate `perm:*` keys, not as competing `license:tier` values.
      return {
        success: true,
        licensed: true,
        tier: resolved.values[0] ?? null,
        status: 200,
      }
    }

    // floating
    const { rowCount } = await dbClient.query(
      `SELECT 1 FROM app_floating_sessions
        WHERE app_uuid = $1 AND org_uuid = $2 AND user_uuid = $3
          AND expires_at > NOW()
        LIMIT 1`,
      [app.app_uuid, org_uuid, user_uuid]
    )
    return {
      success: true,
      licensed: (rowCount ?? 0) > 0,
      tier: null,
      status: 200,
    }
  } catch (error) {
    console.error("Error in isLicensed:", error)
    return {
      error: true,
      message: "Could not check licence.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Token-time entitlement read ------------------------------------------

export interface EntitlementClaim {
  app_uuid: string
  org_uuid: string
  licensing_mode: AppLicensingMode
  tier: string | null
  perms: Record<string, string>
}

/**
 * Builds the entitlement payload baked into the OIDC `puff:entitlements`
 * claim. Walks the resolver against the requesting app's owner namespace for
 * the tier and every permission key the app declares (`perm:<name>`), so the
 * caller does not need to know which keys exist — just which app + user +
 * org context applies.
 *
 * Missing perms are simply omitted from the result rather than emitted with
 * a null value; the consuming app can treat absence as "not granted".
 */
export async function listEntitlementsForToken(
  dbClient: DbClient,
  app: { app_uuid: string; app_licensing_mode: AppLicensingMode },
  user_uuid: string,
  org_uuid: string
): Promise<Envelope<{ claim: EntitlementClaim }>> {
  try {
    const owner = { type: "app" as const, app_uuid: app.app_uuid }

    const declared = await listAppPermissions(dbClient, app.app_uuid)
    if (!declared.success) return declared

    const perms: Record<string, string> = {}
    for (const perm of declared.perms) {
      const key = `${PERM_PREFIX}${perm.name}`
      const resolved = await resolveKeyValue(dbClient, {
        owner,
        key,
        user_uuid,
        org_uuid,
      })
      if (!resolved.success) return resolved
      if (resolved.values.length > 0) {
        perms[perm.name] = resolved.values[0] ?? ""
      }
    }

    let tier: string | null = null
    if (app.app_licensing_mode === "seat") {
      const tierResolved = await resolveKeyValue(dbClient, {
        owner,
        key: LICENSE_TIER_KEY,
        user_uuid,
        org_uuid,
      })
      if (!tierResolved.success) return tierResolved
      if (tierResolved.values.length > 0) {
        tier = tierResolved.values[0] ?? null
      }
    }

    return {
      success: true,
      claim: {
        app_uuid: app.app_uuid,
        org_uuid,
        licensing_mode: app.app_licensing_mode,
        tier,
        perms,
      },
      status: 200,
    }
  } catch (error) {
    console.error("Error in listEntitlementsForToken:", error)
    return {
      error: true,
      message: "Could not build entitlement claim.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- Per-org seat / licence summary (billing readout) ---------------------

/**
 * Counts the licensed subjects in an org for billing or admin display. The
 * meaning of "licensed" depends on the mode:
 *
 *   none     — always 0; no licence concept.
 *   seat     — distinct users with a `license:tier` entitlement granted by
 *              the org (directly, via team or role inheritance is harder to
 *              enumerate so this is the directly-granted count).
 *   usage    — distinct users with any KV row owned by the app and the org.
 *   floating — distinct users currently holding a seat in the pool, plus the
 *              configured pool size.
 */
export async function summariseLicensing(
  dbClient: DbClient,
  app: { app_uuid: string; app_licensing_mode: AppLicensingMode },
  org_uuid: string
): Promise<
  Envelope<{
    mode: AppLicensingMode
    assigned: number
    active?: number
    max?: number | null
  }>
> {
  try {
    if (app.app_licensing_mode === "none") {
      return { success: true, mode: "none", assigned: 0, status: 200 }
    }

    if (app.app_licensing_mode === "seat") {
      // Users with a `license:tier` granted at any subject level by this
      // org. The org grants by adding a `user_key_values` / `team_key_values`
      // / `organisation_key_values` / `*_role_key_values` row owned by the
      // app; we count the distinct user-subject rows because they are the
      // only level where a user is uniquely identified.
      const { rows } = await dbClient.query(
        `SELECT count(DISTINCT user_uuid)::INT AS count
           FROM user_key_values
          WHERE owner_app_uuid = $1
            AND kv_key = $2
            AND user_uuid IN (
              SELECT user_uuid FROM organisation_members WHERE org_uuid = $3
            )`,
        [app.app_uuid, LICENSE_TIER_KEY, org_uuid]
      )
      return {
        success: true,
        mode: "seat",
        assigned: rows[0]?.count ?? 0,
        status: 200,
      }
    }

    if (app.app_licensing_mode === "usage") {
      const { rows } = await dbClient.query(
        `SELECT count(DISTINCT user_uuid)::INT AS count
           FROM user_key_values
          WHERE owner_app_uuid = $1
            AND user_uuid IN (
              SELECT user_uuid FROM organisation_members WHERE org_uuid = $2
            )`,
        [app.app_uuid, org_uuid]
      )
      return {
        success: true,
        mode: "usage",
        assigned: rows[0]?.count ?? 0,
        status: 200,
      }
    }

    // floating
    const active = await dbClient.query(
      `SELECT count(*)::INT AS count
         FROM app_floating_sessions
        WHERE app_uuid = $1 AND org_uuid = $2 AND expires_at > NOW()`,
      [app.app_uuid, org_uuid]
    )
    const max = await dbClient.query(
      `SELECT kv_value FROM organisation_key_values
        WHERE org_uuid = $1 AND owner_app_uuid = $2
          AND kv_key = 'license:floating:max' LIMIT 1`,
      [org_uuid, app.app_uuid]
    )
    const maxValue = max.rows[0]?.kv_value
    const parsedMax =
      maxValue === undefined ? null : Number.parseInt(maxValue, 10)
    return {
      success: true,
      mode: "floating",
      assigned: active.rows[0]?.count ?? 0,
      active: active.rows[0]?.count ?? 0,
      max: Number.isFinite(parsedMax) ? parsedMax : null,
      status: 200,
    }
  } catch (error) {
    console.error("Error in summariseLicensing:", error)
    return {
      error: true,
      message: "Could not summarise licensing.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// --- OAuth org-context resolution -----------------------------------------

/**
 * Returns the orgs the user could be acting through for `(user, app)` —
 * orgs they are a member of where the app has at least one entitlement row
 * owned by it. The result is the set of choices we offer at consent time
 * when an OAuth request does not explicitly carry an `org_uuid`.
 *
 * For `app_licensing_mode === 'none'`, an app might not have any entitlement
 * rows at all; the result will be empty. The caller should treat
 * `none`-mode apps as not needing an org context and skip this check.
 */
export async function findEligibleOrgs(
  dbClient: DbClient,
  app_uuid: string,
  user_uuid: string
): Promise<Envelope<{ orgs: { org_uuid: string; org_name: string }[] }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT DISTINCT o.org_uuid, o.org_name
         FROM organisations o
         JOIN organisation_members om ON om.org_uuid = o.org_uuid
        WHERE om.user_uuid = $1
          AND o.org_active = TRUE
          AND (
                EXISTS (
                  SELECT 1 FROM organisation_key_values okv
                   WHERE okv.org_uuid = o.org_uuid AND okv.owner_app_uuid = $2
                  LIMIT 1
                )
             OR EXISTS (
                  SELECT 1 FROM user_key_values ukv
                   WHERE ukv.user_uuid = $1 AND ukv.owner_app_uuid = $2
                  LIMIT 1
                )
             OR EXISTS (
                  SELECT 1 FROM team_key_values tkv
                   JOIN teams t ON t.team_uuid = tkv.team_uuid
                   JOIN team_members tm ON tm.team_uuid = t.team_uuid
                  WHERE t.org_uuid = o.org_uuid
                    AND tm.user_uuid = $1
                    AND tkv.owner_app_uuid = $2
                  LIMIT 1
                )
             OR EXISTS (
                  SELECT 1 FROM org_role_key_values orkv
                   JOIN organisation_members om2
                     ON om2.org_uuid = orkv.org_uuid AND om2.role = orkv.role
                  WHERE orkv.org_uuid = o.org_uuid
                    AND om2.user_uuid = $1
                    AND orkv.owner_app_uuid = $2
                  LIMIT 1
                )
              )
        ORDER BY o.org_name ASC`,
      [user_uuid, app_uuid]
    )
    return { success: true, orgs: rows, status: 200 }
  } catch (error) {
    console.error("Error in findEligibleOrgs:", error)
    return {
      error: true,
      message: "Could not list eligible organisations.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

// Re-export the prefix constants — entitlement endpoints validate that
// caller-supplied keys are in the allowed namespace.
export { LICENSE_PERMS_PREFIX, PERM_PREFIX }
