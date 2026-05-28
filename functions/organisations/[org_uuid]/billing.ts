import { getCookie } from "../../../src/utilities/headers.js"
import { setNextCookie } from "../../../src/utilities/next.js"

/**
 * `/organisations/:org_uuid/billing` — the billing management page for an
 * organisation.
 *
 * A Pages Function shell, not a static file, because the page is parameterised
 * by the organisation UUID. It renders a shell with three HTMX-loaded sections:
 *
 * - **Current subscriptions** — from `/billing/summary`
 * - **Payment methods** — a portal button (write-gated)
 * - **Billing history** — from `/billing/invoices/list`
 *
 * Presence-only auth here: the `session_token` cookie must be present or the
 * visitor is redirected to `/login` (with the destination stashed). Real
 * permission enforcement (`org:billing:read` / `org:billing:write`) happens in
 * the API fragment endpoints that this page loads, exactly as the org
 * management shell defers real auth to its `[org_uuid]/read` fragment.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const { request, env } = context
  const org_uuid = String(context.params.org_uuid)

  const sessionToken = await getCookie(
    request.headers.get("Cookie"),
    "session_token"
  )
  if (!sessionToken) {
    const headers = new Headers({ Location: "/login" })
    headers.append(
      "Set-Cookie",
      setNextCookie(env, new URL(request.url).pathname)
    )
    return new Response(null, { status: 302, headers })
  }

  const base = `/api/db/auth/organisations/${encodeURIComponent(org_uuid)}`
  const orgPage = `/organisations/${encodeURIComponent(org_uuid)}`

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":".*","swap":true}]}'
    />
    <title>Billing</title>
    <link rel="stylesheet" href="/assets/main.css" />
    <script src="/assets/htmx_2.0.4.min.js"></script>
  </head>
  <body>
    <div class="container wide">
      <header><h1>Billing</h1></header>
      <main>
        <p><a href="${orgPage}">&larr; Back to organisation</a></p>

        <div class="grid-container grid-header">
          <div class="grid-item"><h2>Current Subscriptions</h2></div>
        </div>
        <div
          id="billing-subscriptions"
          hx-get="${base}/billing/summary"
          hx-trigger="load, billingChanged from:body"
          hx-swap="innerHTML"
        >
          <p>Loading subscriptions...</p>
        </div>

        <div class="grid-container grid-header spacer-top">
          <div class="grid-item"><h2>Payment Methods</h2></div>
          <div class="grid-item">
            <form
              hx-post="${base}/billing/payment-methods/portal"
              hx-target="#billing-message-area"
              hx-swap="innerHTML"
              hx-disabled-elt=".btn-safe"
            >
              <button type="submit" class="btn-safe">
                Manage Payment Methods
                <img class="htmx-indicator" src="/assets/bars.svg" />
              </button>
            </form>
          </div>
        </div>
        <div id="billing-message-area" class="result-area spacer-bottom"></div>

        <div class="grid-container grid-header spacer-top">
          <div class="grid-item"><h2>Billing History</h2></div>
        </div>
        <div
          id="billing-invoices"
          hx-get="${base}/billing/invoices/list"
          hx-trigger="load, billingChanged from:body"
          hx-swap="innerHTML"
        >
          <p>Loading invoices...</p>
        </div>
      </main>
    </div>
  </body>
</html>`

  return new Response(body, {
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
