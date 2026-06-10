import { readKeyValues, searchKeyValues } from "../../../src/user-keyvalues.js"
import { escapeHtml } from "../../../src/utilities/escape.js"

/**
 * Lists the authenticated user's self-owned key/value pairs as an HTML table
 * fragment. Owner and subject are both the caller — what they have stored
 * about themselves. An optional `?key=` query parameter filters the list.
 */
export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!
  const owner = { type: "user" as const, user_uuid }

  try {
    const url = new URL(context.request.url)
    const search = (url.searchParams.get("key") ?? "").trim()

    const result = search ? await searchKeyValues(dbClient, user_uuid, owner, search) : await readKeyValues(dbClient, user_uuid, owner)

    if (!result.success) {
      return new Response(`<p class="result-negative">${escapeHtml(result.message)}</p>`, {
        status: result.status,
        headers: { "Content-Type": "text/html" },
      })
    }

    if (result.pairs.length === 0) {
      const message = search ? `No keys match "${escapeHtml(search)}".` : "No stored keys yet."
      return new Response(`<p>${message}</p>`, {
        headers: { "Content-Type": "text/html" },
      })
    }

    let html = "<table><thead><tr><th>Key</th><th>Value</th><th>Actions</th></tr></thead><tbody>"
    for (const pair of result.pairs) {
      html += `<tr>
        <td>${escapeHtml(pair.kv_key)}</td>
        <td>${escapeHtml(pair.kv_value)}</td>
        <td>
          <button
            class="btn-danger"
            hx-post="/api/keyvalues/remove"
            hx-vals='${escapeHtml(JSON.stringify({ key: pair.kv_key }))}'
            hx-target="#keyvalue-message-area"
            hx-swap="innerHTML"
            hx-confirm="Are you sure you want to delete the key &quot;${escapeHtml(pair.kv_key)}&quot;?"
            hx-disable="this"
          >Delete</button>
        </td>
      </tr>`
    }
    html += "</tbody></table>"

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error in /api/keyvalues/list:", error)
    return new Response('<p class="result-negative">Failed to load stored keys due to a server error.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
