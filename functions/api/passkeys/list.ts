import { listPasskeys } from "../../../src/passkeys.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  const result = await listPasskeys(dbClient, user_uuid)
  if (result.error || !result.success) {
    return new Response('<p class="result-negative">Could not load passkeys.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }

  if (result.passkeys.length === 0) {
    return new Response('<p class="result-info">No passkeys registered yet.</p>', { status: 200, headers: { "Content-Type": "text/html" } })
  }

  const rows = result.passkeys
    .map((pk: PasskeyRow) => {
      const created = new Date(pk.created_at).toLocaleDateString()
      const lastUsed = pk.last_used_at ? new Date(pk.last_used_at).toLocaleDateString() : "Never"
      const name = pk.passkey_name ?? "Passkey"
      return `<div class="grid-container passkey-row">
        <div class="grid-item"><strong>${name}</strong><br/><small>Added ${created} &middot; Last used ${lastUsed}</small></div>
        <div class="grid-item">
          <button
            class="btn-danger"
            hx-post="/api/passkeys/delete"
            hx-vals='{"passkey_uuid":"${pk.passkey_uuid}"}'
            hx-target="#passkey-message-area"
            hx-swap="innerHTML"
            hx-confirm="Remove this passkey?"
            hx-disable="this"
          >Remove<img class="htmx-indicator" src="/assets/bars.svg" /></button>
        </div>
      </div>`
    })
    .join("")

  return new Response(rows, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  })
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
