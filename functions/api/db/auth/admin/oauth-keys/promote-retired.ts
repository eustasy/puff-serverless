import {
  resultNegative,
  resultPositive,
  methodNotAllowed,
} from "../../../../../../src/utilities/responses.js"
import { promoteRetiredKey } from "../../../../../../src/oauth-keys-rotation.js"

// Emergency rollback for OAuth signing-key rotation. Promotes the retired
// key back to active. Only works while the retired KV entry still carries
// a private scalar `d` — the normal rotation flow strips `d` before writing
// to `oauth:keys:retired`, so this is only useful when the operator has
// manually seeded a private retired key (or a future revision starts
// holding the full keypair during the overlap window).
//
// Routed under /api/db/auth/admin/ so the operator-only gate in the
// admin middleware applies.
export const onRequestPost: Handler = async (context) => {
  const user_uuid = context.data.user_uuid ?? null
  try {
    const result = await promoteRetiredKey(context.env, {
      actor_user_uuid: user_uuid,
    })
    if (!result.promoted) {
      return resultNegative(result.reason, 409)
    }
    console.log(
      `OAuth signing-key promote-retired: triggered by ${user_uuid ?? "unknown"}; ` +
        `new_kid=${result.new_kid}.`
    )
    return resultPositive(
      `Promoted retired key. New active kid: ${result.new_kid}.`
    )
  } catch (error) {
    console.error("Manual OAuth key promote-retired failed:", error)
    return resultNegative(
      error instanceof Error ? error.message : "Promotion failed.",
      500
    )
  }
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
