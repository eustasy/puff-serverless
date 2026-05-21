import { unlinkExternalIdentity } from "../../../../../src/external-identities.js"
import {
  methodNotAllowed,
  resultNegative,
  resultPositive,
} from "../../../../../src/utilities/responses.js"

/**
 * Removes a linked identity. The safety check in `unlinkExternalIdentity`
 * refuses to remove the last credential — a user must keep a password, a
 * passkey, or at least one other linked identity, or they would lose all
 * access to the account.
 */
export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  let form: FormData
  try {
    form = await context.request.formData()
  } catch {
    return resultNegative("Invalid form submission.", 400)
  }
  const provider = form.get("provider")
  const provider_user_id = form.get("provider_user_id")
  if (typeof provider !== "string" || typeof provider_user_id !== "string") {
    return resultNegative("Missing provider or provider_user_id.", 400)
  }

  const result = await unlinkExternalIdentity(
    dbClient,
    user_uuid,
    provider,
    provider_user_id
  )
  if (!result.success) {
    return resultNegative(result.message ?? "Could not unlink.", result.status)
  }
  return resultPositive("Sign-in provider unlinked.", 200, {
    "HX-Trigger": "externalIdentitiesChanged",
  })
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
