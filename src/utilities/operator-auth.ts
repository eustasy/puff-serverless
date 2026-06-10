import { resultNegative } from "./responses.js"
import { parseOperatorUuids } from "./operator-uuids.js"

// Operator-only gate for /api/admin/... — endpoints that rotate
// keys, run manual purges, and so on. Puff has no admin role on a user row;
// instead the operator lists trusted user UUIDs in OPERATOR_USER_UUIDS
// (comma- or whitespace-separated). An empty list locks the whole section
// out, which is the safer default for a misconfigured deploy.
//
// The session-auth middleware one level up has already populated
// `context.data.user_uuid`, so this is purely an authorisation check.

export const operatorAuthMiddleware: Handler = async (context) => {
  const user_uuid = context.data.user_uuid
  const operators = parseOperatorUuids(context.env.OPERATOR_USER_UUIDS)

  if (operators.size === 0) {
    console.warn(
      "Admin endpoint blocked: OPERATOR_USER_UUIDS is empty. Set it to the " +
        "comma-separated UUIDs of trusted operators to unlock /api/admin."
    )
    return resultNegative("Admin endpoints are disabled (OPERATOR_USER_UUIDS not configured).", 503)
  }
  if (!user_uuid || !operators.has(user_uuid)) {
    return resultNegative("Not authorised.", 403)
  }
  return context.next()
}
