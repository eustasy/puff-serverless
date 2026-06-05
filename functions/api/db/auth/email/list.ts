import { readEmails } from "../../../../../src/emails.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"

export const onRequestGet: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  try {
    const emails = await readEmails(dbClient, user_uuid)
    if (!emails || emails.length === 0) {
      return new Response("<p>No email addresses found for this account.</p>", {
        headers: { "Content-Type": "text/html" },
      })
    }

    let html = "<table><thead><tr><th>Email Address</th><th>Status</th><th>Actions</th></tr></thead><tbody>"
    for (const email of emails) {
      html += `<tr>
        <td>${escapeHtml(email.email_address)}</td>
        <td>
            ${email.is_primary ? '<span class="badge bg-primary">Primary</span>' : ""}
            ${email.is_verified ? '<span class="badge bg-success">Verified</span>' : '<span class="badge bg-warning">Unverified</span>'}
        </td>
        <td>`
      // Only allow making an email primary if it is not already primary and is verified
      if (!email.is_primary && email.is_verified) {
        html += `<button
                    class="btn-save"
                    hx-post="/api/db/auth/email/primary"
                    hx-vals='${escapeHtml(JSON.stringify({ email_address: email.email_address }))}'
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
                    hx-post="/api/db/auth/email/remove"
                    hx-vals='${escapeHtml(JSON.stringify({ email_address: email.email_address }))}'
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
                    hx-post="/api/db/auth/email/resend"
                    hx-vals='${escapeHtml(JSON.stringify({ email_address: email.email_address }))}'
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
    console.error("Error in onRequestGet for /api/db/auth/email/list:", error)
    return new Response('<p class="result-negative">Failed to load email addresses due to a server error.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
