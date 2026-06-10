import { escapeHtml } from "../src/utilities/escape.js"

/**
 * `/invite?token=…` — the page an organisation-invitation email links to.
 *
 * A Pages Function rather than a static file because the page needs the `?token`
 * from the URL (a static `.html` cannot read its own query string without
 * client JS, which this project does not use). The function only bakes the
 * token into the markup — it touches no database. The page then:
 *   - previews the invitation via `GET /api/organisations/invitation/view`
 *     (unauthenticated), and
 *   - accepts it via `POST /api/organisations/invitation/accept`, which
 *     requires a session — an unauthenticated visitor signs in or registers and
 *     returns to the same link.
 */
export const onRequestGet: Handler = async (context) => {
  const token = new URL(context.request.url).searchParams.get("token") ?? ""
  if (!token) {
    return new Response("Missing invitation token.", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    })
  }
  const tokenAttr = escapeHtml(token)
  const tokenParam = encodeURIComponent(token)

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":".*","swap":true}]}'
    />
    <title>Organisation Invitation</title>
    <link rel="stylesheet" href="/assets/main.css" />
    <script src="/assets/htmx_2.0.4.min.js"></script>
  </head>
  <body>
    <div class="container">
      <header><h1>Organisation Invitation</h1></header>
      <main>
        <div
          hx-get="/api/organisations/invitation/view?token=${tokenParam}"
          hx-trigger="load"
          hx-swap="innerHTML"
        >
          <p>Loading invitation...</p>
        </div>

        <div id="invite-message-area" class="result-area spacer-bottom"></div>

        <form
          hx-post="/api/organisations/invitation/accept"
          hx-target="#invite-message-area"
          hx-swap="innerHTML"
        >
          <input type="hidden" name="token" value="${tokenAttr}" />
          <button type="submit" class="btn-save">Accept invitation</button>
        </form>

        <p>
          You must be signed in to accept.
          <a href="/login">Log in</a> or <a href="/register">register</a>,
          then return to this link.
        </p>
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
