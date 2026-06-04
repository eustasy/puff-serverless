import { resultNegative, resultPositive, methodNotAllowed } from "../../../../../../src/utilities/responses.js"
import { rotateSigningKey } from "../../../../../../src/oauth-keys-rotation.js"

// Operator-triggered key rotation. Runs the same code path as the daily
// cron in `src/cron.ts`. Always rotates — does not consult the age check.
// Use this to rehearse rotation in staging or to respond to a suspected
// compromise.
export const onRequestPost: Handler = async (context) => {
  const user_uuid = context.data.user_uuid
  try {
    const result = await rotateSigningKey(context.env, {
      trigger: "manual",
    })
    console.log(
      `OAuth signing-key rotation: triggered by ${user_uuid ?? "unknown"}; ` +
        `new_kid=${result.new_kid}, retired_kid=${result.retired_kid ?? "none"}.`
    )
    return resultPositive(`Rotated. New kid: ${result.new_kid}. ` + `Previous kid: ${result.retired_kid ?? "(none — first rotation)"}.`)
  } catch (error) {
    console.error("Manual OAuth key rotation failed:", error)
    return resultNegative(error instanceof Error ? error.message : "Rotation failed.", 500)
  }
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
