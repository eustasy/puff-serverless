import { readEmails } from "../../../src/emails"
import { sessionAuthWithCookie } from "../../../src/sessions.js"

export async function onRequestGet(context) {
  // Changed to receive full context object
  try {
    const sessionResult = await sessionAuthWithCookie(context)
    if (sessionResult.error) {
      return new Response(
        `<p class="result-negative">${sessionResult.error}</p>`,
        {
          status: sessionResult.status || 401,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    const user_uuid = sessionResult

    const emails = await readEmails(context, user_uuid)
    if (!emails || emails.length === 0) {
      return new Response("<p>No email addresses found for this account.</p>", {
        headers: { "Content-Type": "text/html" },
      })
    }

    let html =
      "<table><thead><tr><th>Email Address</th><th>Status</th><th>Actions</th></tr></thead><tbody>"
    for (const email of emails) {
      html += `<tr>
        <td>${email.email_address}</td>
        <td>
            ${email.is_primary ? '<span class="badge bg-primary">Primary</span>' : ""}
            ${email.is_verified ? '<span class="badge bg-success">Verified</span>' : '<span class="badge bg-warning">Unverified</span>'}
        </td>
        <td>`
      // Only allow making an email primary if it is not already primary and is verified
      if (!email.is_primary && email.is_verified) {
        html += `<button
                    class="btn-save"
                    hx-post="/api/email/primary"
                    hx-vals='{"email_address": "${email.email_address}"}'
                    hx-target="#email-list-container"
                    hx-swap="innerHTML"
                    hx-trigger="click"
                    hx-disabled-elt="this"
                >Make Primary</button> `
      }
      // Only allow removing non-primary emails
      if (!email.is_primary) {
        html += `<button
                    class="btn-danger"
                    hx-post="/api/email/remove"
                    hx-vals='{"email_address": "${email.email_address}"}'
                    hx-target="#email-message-area"
                    hx-swap="innerHTML"
                    hx-trigger="click"
                    hx-confirm="Are you sure you want to remove this email address?"
                    hx-disabled-elt="this"
                >Remove</button> `
      }
      // Always allow resending verification for unverified emails
      if (!email.is_verified) {
        html += `<button
                    class="btn-save"
                    hx-post="/api/email/resend"
                    hx-vals='{"email_address": "${email.email_address}"}'
                    hx-target="#email-message-area"
                    hx-swap="innerHTML"
                    hx-trigger="click"
                    hx-disabled-elt="this"
                >Resend Verification</button>`
      }
      html += `</td></tr>`
    }
    html += "</tbody></table>"

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error in onRequestGet for /api/email/list:", error)
    return new Response(
      '<p class="result-negative">Failed to load email addresses due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export async function onRequest(context) {
  // Ensure only GET requests are handled by onRequestGet
  if (context.request.method === "GET") {
    return onRequestGet(context)
  }
  return new Response('<p class="result-negative">Method Not Allowed</p>', {
    status: 405,
    headers: { "Allow": "GET", "Content-Type": "text/html" },
  })
}
