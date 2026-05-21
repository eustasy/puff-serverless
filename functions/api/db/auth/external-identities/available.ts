// HTML fragment listing the federated-login providers the caller has NOT
// yet linked. Used by the "Add another provider" disclosure on /account
// so a provider only ever appears in one of two places per user: the
// linked-accounts list, or the add-another list.
//
// Distinct from the unauthenticated `/api/providers` fragment used by
// /login — that one lists every configured provider regardless of any
// existing link.

import { listExternalIdentities } from "../../../../../src/external-identities.js"
import { listConfiguredProviders } from "../../../../../src/oauth-providers.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  methodNotAllowed,
  resultNegative,
} from "../../../../../src/utilities/responses.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const linked = await listExternalIdentities(dbClient, user_uuid)
  if (!linked.success) {
    return resultNegative(
      linked.message ?? "Could not load linked accounts.",
      500
    )
  }
  const linkedProviders = new Set(linked.identities.map((i) => i.provider))

  const available = listConfiguredProviders(context.env).filter(
    (p) => !linkedProviders.has(p.name)
  )
  if (available.length === 0) {
    return htmlResponse(
      '<p class="result-info">All configured providers are already linked.</p>'
    )
  }
  const buttons = available
    .map(
      (p) =>
        `<a class="btn-safe" href="/login/${encodeURIComponent(p.name)}">${escapeHtml(p.display_name)}</a>`
    )
    .join(" ")
  return htmlResponse(`<p>${buttons}</p>`)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
