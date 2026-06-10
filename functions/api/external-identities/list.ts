import { listExternalIdentities } from "../../../src/external-identities.js"
import { getProviderConfig } from "../../../src/oauth-providers.js"
import { escapeHtml } from "../../../src/utilities/escape.js"
import { htmlResponse, methodNotAllowed, resultNegative } from "../../../src/utilities/responses.js"

/**
 * Renders the user's linked third-party identities as an HTML fragment for
 * the account page. Each row carries a Remove button POSTing to unlink.
 */
export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const result = await listExternalIdentities(dbClient, user_uuid)
  if (!result.success) {
    return resultNegative(result.message ?? "Could not load linked accounts.", 500)
  }
  if (result.identities.length === 0) {
    return htmlResponse('<p class="result-info">No linked sign-in providers yet.</p>')
  }

  const rows = result.identities
    .map((id: ExternalIdentityRow) => {
      const providerLabel = getProviderConfig(id.provider)?.display_name ?? id.provider
      const linked = new Date(id.linked_at).toLocaleDateString()
      const lastUsed = id.last_used_at ? new Date(id.last_used_at).toLocaleDateString() : "Never"
      const subtitle = id.email
        ? `${escapeHtml(id.email)} &middot; Linked ${linked} &middot; Last used ${lastUsed}`
        : `Linked ${linked} &middot; Last used ${lastUsed}`
      return `<div class="grid-container identity-row">
        <div class="grid-item"><strong>${escapeHtml(providerLabel)}</strong><br/><small>${subtitle}</small></div>
        <div class="grid-item">
          <button
            class="btn-danger"
            hx-post="/api/external-identities/unlink"
            hx-vals='${escapeHtml(JSON.stringify({ provider: id.provider, provider_user_id: id.provider_user_id }))}'
            hx-target="#external-identities-message-area"
            hx-swap="innerHTML"
            hx-confirm="Unlink ${escapeHtml(providerLabel)}?"
            hx-disabled-elt="this"
          >Unlink</button>
        </div>
      </div>`
    })
    .join("")

  return htmlResponse(rows)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
