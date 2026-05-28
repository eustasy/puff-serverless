// Usage ingest endpoint for `usage`-mode apps. Apps POST metered events here,
// authenticated by their OAuth app credentials (HTTP Basic, same as
// /oauth/token) — NOT by a user session. The authenticated app may only report
// usage for itself (path `[app_uuid]` must match the credentialed app) and only
// for an org it has a subscription with. Idempotency is enforced downstream by
// the unique `(app_uuid, idempotency_key)` constraint, so retries are safe.
//
// JSON in / JSON out (machine endpoint):
//   body: { org_uuid, user_uuid?, metric, quantity, occurred_at, idempotency_key }
//   200  { recorded: true, event_uuid }
//   4xx  { error: "..." }

import { parseBasicAuth } from "../../../../src/utilities/oauth-token.js"
import { verifyAppCredentials } from "../../../../src/apps.js"
import { getSubscriptionForApp } from "../../../../src/billing.js"
import { recordUsageEvent } from "../../../../src/usage.js"
import { emitFromContext } from "../../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../../src/hooks/events.js"

function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

export const onRequestPost: Handler<"app_uuid"> = async (context) => {
  const dbClient = context.data.dbClient!
  const app_uuid = String(context.params.app_uuid)

  // --- Authenticate by app credentials (HTTP Basic) ---
  const basic = parseBasicAuth(context.request.headers.get("Authorization"))
  if (!basic) {
    return json({ error: "client credentials required" }, 401, {
      "WWW-Authenticate": 'Basic realm="billing"',
    })
  }
  const creds = await verifyAppCredentials(
    dbClient,
    basic.client_id,
    basic.client_secret
  )
  if (creds.error || !creds.success || !creds.verified || !creds.app) {
    return json({ error: "invalid client credentials" }, 401, {
      "WWW-Authenticate": 'Basic realm="billing"',
    })
  }
  // An app may only report its own usage.
  if (creds.app.app_uuid !== app_uuid) {
    return json({ error: "credentials do not match this app" }, 403)
  }

  // --- Parse + validate body ---
  let body: Record<string, unknown>
  try {
    body = (await context.request.json()) as Record<string, unknown>
  } catch {
    return json({ error: "invalid JSON body" }, 400)
  }

  const org_uuid = typeof body.org_uuid === "string" ? body.org_uuid : ""
  const metric = typeof body.metric === "string" ? body.metric : ""
  const idempotency_key =
    typeof body.idempotency_key === "string" ? body.idempotency_key : ""
  const quantity =
    typeof body.quantity === "number" ? body.quantity : Number(body.quantity)
  const occurred_at =
    typeof body.occurred_at === "string" ? body.occurred_at : ""
  const user_uuid = typeof body.user_uuid === "string" ? body.user_uuid : null

  if (!org_uuid) return json({ error: "org_uuid is required" }, 400)
  if (!metric) return json({ error: "metric is required" }, 400)
  if (!idempotency_key)
    return json({ error: "idempotency_key is required" }, 400)
  if (!occurred_at) return json({ error: "occurred_at is required" }, 400)

  // --- The org must have a subscription for this app ---
  const sub = await getSubscriptionForApp(dbClient, org_uuid, app_uuid)
  if (sub.error) {
    return json({ error: "could not verify subscription" }, 500)
  }
  if (!sub.success || !sub.subscription) {
    return json({ error: "no subscription for this org and app" }, 403)
  }

  // --- Record (idempotent on (app_uuid, idempotency_key)) ---
  const result = await recordUsageEvent(dbClient, {
    app_uuid,
    org_uuid,
    user_uuid,
    metric,
    quantity,
    occurred_at,
    idempotency_key,
  })
  if (result.error) {
    return json({ error: "could not record usage event" }, 500)
  }
  if (!result.success) {
    return json({ error: result.message }, result.status)
  }

  await emitFromContext(context, {
    event_type: EVENTS.BILLING_USAGE_RECORDED,
    actor_user_uuid: null,
    target_org_uuid: org_uuid,
    target_app_uuid: app_uuid,
    event_metadata: { metric, idempotency_key },
  })

  return json({ recorded: true, event_uuid: result.event_uuid }, result.status)
}

export const onRequest: Handler = async () =>
  new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", "Allow": "POST" },
  })
