import { readApp } from "../../../../../../../../src/apps.js"
import { resultNegative } from "../../../../../../../../src/utilities/responses.js"

/**
 * Resolves the `[app_uuid]` segment to a registered, active app and stashes
 * the row on `context.data.app`. 404s a missing or disabled app so the
 * entitlement endpoints can assume `data.app` is set.
 *
 * The org/app pair is NOT validated here — apps are globally registered, so
 * "this org grants entitlements for that app" is the act of granting itself.
 * The grantee-in-org check happens per-write at the leaf endpoints.
 */
const resolveApp: Handler<"app_uuid" | "org_uuid"> = async (context) => {
  const { data, params, next } = context
  const app_uuid = String(params.app_uuid)

  const result = await readApp(data.dbClient!, app_uuid)
  if (result.error) {
    return resultNegative("Could not load app.", 500)
  }
  if (!result.success) {
    return resultNegative("App not found.", 404)
  }
  data.app = result.app
  return next()
}

export const onRequest = [resolveApp]
