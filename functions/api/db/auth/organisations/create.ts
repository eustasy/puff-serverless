import { createOrganisation } from "../../../../../src/organisations.js"
import {
  resultPositive,
  resultNegative,
  methodNotAllowed,
} from "../../../../../src/utilities/responses.js"

/**
 * Creates an organisation for the authenticated user, who becomes its first
 * owner. Any authenticated user may create an organisation.
 */
export const onRequestPost: Handler = async (context) => {
  let name = ""
  let slug = ""
  try {
    const formData = await context.request.formData()
    name = String(formData.get("name") ?? "")
    slug = String(formData.get("slug") ?? "")
  } catch {
    return resultNegative("Invalid request format. Expected form data.", 400)
  }

  const result = await createOrganisation(
    context.data.dbClient!,
    name,
    slug,
    context.data.user_uuid!
  )
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  return resultPositive(
    `Organisation "${result.organisation.org_name}" created.`,
    result.status,
    { "HX-Trigger": "organisationsChanged" }
  )
}

export const onRequest: Handler = async () => methodNotAllowed("POST")
