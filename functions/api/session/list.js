import {
  sessionAuthWithCookie,
  listActiveSessionsForUser,
  getCookie,
} from "../../../src/sessions.js"

export async function onRequestGet(context) {
  const sessionVerificationResult = await sessionAuthWithCookie(context)
  if (sessionVerificationResult && sessionVerificationResult.error) {
    if (sessionVerificationResult instanceof Response)
      return sessionVerificationResult
    return new Response(
      `<p class=\"error\">${sessionVerificationResult.message || "Session validation failed."}</p>`,
      {
        status: sessionVerificationResult.status || 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  const user_uuid = context.data.user_uuid
  if (!user_uuid) {
    return new Response(
      '<p class="error">Unauthorized. No user UUID found after session auth.</p>',
      {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  const cookieHeader = context.request.headers.get("Cookie")
  const currentSessionToken = await getCookie(cookieHeader, "session_token")

  try {
    const result = await listActiveSessionsForUser(context, user_uuid)

    if (result.error) {
      return new Response(`<p class=\"error\">${result.error}</p>`, {
        status: result.status,
        headers: { "Content-Type": "text/html" },
      })
    }

    let html =
      "<table><thead><tr><th>Created At</th><th>Expires At</th><th>User Agent</th><th>IP Address</th><th>Status</th></tr></thead><tbody>"
    if (result.sessions && result.sessions.length > 0) {
      result.sessions.forEach((session) => {
        html += `<tr>
          <td>${new Date(session.created_at).toLocaleString()}</td>
          <td>${new Date(session.expires_at).toLocaleString()}</td>
          <td>${session.user_agent || "N/A"}</td>
          <td>${session.ip_address || "N/A"}</td>
          <td>${session.session_id === currentSessionToken ? "<strong>Current Session</strong>" : "Active"}</td>
        </tr>`
      })
    } else {
      html += '<tr><td colspan="5">No active sessions found.</td></tr>'
    }
    html += "</tbody></table>"

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error listing active sessions:", error)
    return new Response(
      '<p class="error">Failed to list sessions due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") {
    return await onRequestGet(context)
  }
  return new Response('<p class="error">Method Not Allowed</p>', {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "text/html" },
  })
}
