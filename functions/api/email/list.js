import { readEmails } from "../../../src/emails"
import { sessionAuthWithCookie } from "../../../src/sessions.js"

export async function onRequestGet(context) {
  // Changed to receive full context object
  try {
    const sessionResult = await sessionAuthWithCookie(context)
    if (sessionResult.error) {
      return new Response(`<p class="error">${sessionResult.error}</p>`, {
        status: sessionResult.status || 401,
        headers: { "Content-Type": "text/html" },
      })
    }
    const user_uuid = sessionResult

    const emails = await readEmails(context, user_uuid)
    if (!emails || emails.length === 0) {
      return new Response("<p>No email addresses found for this account.</p>", {
        headers: { "Content-Type": "text/html" },
      })
    }

    let html = '<ul class="list-group">'
    for (const email of emails) {
      html += `<li class="list-group-item">
        <div class="row">
          <div class="col-md-8">
            ${email.email_address}
            ${email.is_primary ? '<span class="badge bg-primary">Primary</span>' : ""}
            ${email.is_verified ? '<span class="badge bg-success">Verified</span>' : '<span class="badge bg-warning">Unverified</span>'}
          </div>
          <div class="col-md-4 text-right">`
      if (!email.is_primary) {
        html += `<button
                    class="btn btn-save"
                    hx-post="/api/email/primary"
                    hx-vals='{"email_id": "${email.id}"}'
                    hx-target="#email-list-container"
                    hx-swap="innerHTML"
                    hx-trigger="click, emailListChanged from:body"
                    hx-disabled-elt="this"
                >Make Primary</button> `
        html += `<button
                    class="btn btn-danger"
                    hx-post="/api/email/remove"
                    hx-vals='{"email_id": "${email.id}"}'
                    hx-target="#email-list-container"
                    hx-swap="innerHTML"
                    hx-trigger="click, emailListChanged from:body"
                    hx-disabled-elt="this"
                    hx-confirm="Are you sure you want to remove this email address?"
                >Remove</button>`
      }
      html += `</div>
        </div>
      </li>`
    }
    html += "</ul>"

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    })
  } catch (error) {
    console.error("Error fetching emails:", error)
    return new Response("<p>Error loading email addresses.</p>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}
