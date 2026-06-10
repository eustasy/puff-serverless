import { getCookie } from "../../src/utilities/headers.js"
import { setNextCookie } from "../../src/utilities/next.js"

/**
 * `/organisations/:org_uuid` — the dedicated organisation management page.
 *
 * A Pages Function, not a static file, because the page is parameterised by
 * the organisation UUID in the path (a static `.html` cannot read it without
 * client JS). It renders only a shell — the management panel itself is the
 * `…/[org_uuid]/read` HTML fragment, loaded by HTMX — so this function needs
 * no database access.
 *
 * Presence-only auth: with no `session_token` cookie the visitor is bounced to
 * `/login` (stashing the destination so login returns here), mirroring the
 * root middleware's Group A pages. The real authorisation is the `auth` +
 * organisation middleware on the `read` fragment's API route.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const { request, env } = context
  const org_uuid = String(context.params.org_uuid)

  const sessionToken = await getCookie(request.headers.get("Cookie"), "session_token")
  if (!sessionToken) {
    const headers = new Headers({ Location: "/login" })
    headers.append("Set-Cookie", setNextCookie(env, new URL(request.url).pathname))
    return new Response(null, { status: 302, headers })
  }

  const panelUrl = `/api/organisations/${encodeURIComponent(org_uuid)}/read`
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":".*","swap":true}]}'
    />
    <title>Organisation</title>
    <link rel="stylesheet" href="/assets/main.css" />
    <script src="/assets/htmx_2.0.4.min.js"></script>
  </head>
  <body>
    <div class="container wide">
      <header><h1>Organisation</h1></header>
      <main>
        <p><a href="/account">&larr; Back to account</a></p>
        <div
          id="organisation-panel"
          hx-get="${panelUrl}"
          hx-trigger="load, organisationChanged from:body"
          hx-swap="innerHTML"
        >
          <p>Loading organisation...</p>
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
