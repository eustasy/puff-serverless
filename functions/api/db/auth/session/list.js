import { listSessionsForUser } from "../../../../../src/sessions.js"
import {
  getCookie,
  parseUserAgent,
} from "../../../../../src/utilities/headers.js"

export async function onRequestGet(context) {
  const dbClient = context.data.dbClient
  const user_uuid = context.data.user_uuid

  const cookieHeader = context.request.headers.get("Cookie")
  const currentSessionToken = await getCookie(cookieHeader, "session_token")

  try {
    const result = await listSessionsForUser(dbClient, user_uuid)

    if (result.error) {
      return new Response(`<p class=\"error\">${result.error}</p>`, {
        status: result.status,
        headers: { "Content-Type": "text/html" },
      })
    }

    let html = `<table><thead><tr>
        <th>Client</th>
        <th>Location</th>
        <th>Created</th>
        <th>Expires</th>
        <th>Action</th>
      </tr></thead><tbody>`
    if (result.sessions && result.sessions.length > 0) {
      result.sessions.forEach((session) => {
        const isCurrentSession = session.session_id === currentSessionToken
        const clientInfo = parseUserAgent(session.user_agent)
        const location = session.ip_country
          ? `${session.ip_address || "N/A"} (${session.ip_country})`
          : session.ip_address || "N/A"
        html += `<tr id="session-${session.session_id}">
          <td>${clientInfo}</td>
          <td>${location}</td>
          <td>${new Date(session.created_at).toLocaleString()}</td>
          <td>${new Date(session.expires_at).toLocaleString()}</td>
          <td>${
            isCurrentSession
              ? `<strong>Current Session</strong>`
              : session.is_active
                ? `<button
                  class="btn-danger"
                  hx-post="/api/db/auth/session/terminate/one?id=${session.session_id}"
                  hx-target="#session-message-area" 
                  hx-swap="innerHTML"
                  hx-confirm="Are you sure you want to terminate this session?"
                >
                  Terminate
                </button>`
                : `<span class="text-muted">Inactive</span>`
          }</td>
        </tr>`
      })
    } else {
      html += '<tr><td colspan="5">No active sessions found.</td></tr>' // Adjusted colspan to 5
    }
    html += "</tbody></table>"

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error listing active sessions:", error)
    return new Response(
      '<p class="result-negative">Failed to list sessions due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
