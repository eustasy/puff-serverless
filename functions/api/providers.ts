// HTML fragment listing the federated-login providers that are configured on
// this deployment. The two pages that show provider buttons (`/login`, the
// "Add another provider" section on `/account`) HTMX-load this fragment on
// page load so unconfigured providers don't appear with a 404 button.
//
// Returns an empty body when no providers are configured, so the section
// disappears entirely instead of leaving a dangling heading.
//
// No DB, no auth — the answer is a pure function of the env vars. Cached
// briefly because the answer only changes when an operator pushes a new
// secret, which is rare.

import { escapeHtml } from "../../src/utilities/escape.js"
import { listConfiguredProviders } from "../../src/oauth-providers.js"
import { methodNotAllowed } from "../../src/utilities/responses.js"

export const onRequestGet: Handler = async (context) => {
  const configured = listConfiguredProviders(context.env)
  if (configured.length === 0) {
    return new Response("", {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=60",
      },
    })
  }
  const buttons = configured
    .map(
      (p) =>
        `<a class="btn-safe" href="/login/${encodeURIComponent(p.name)}">${escapeHtml(p.display_name)}</a>`
    )
    .join(" ")
  const body = `<hr><p>Or continue with:</p><p>${buttons}</p>`
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=60",
    },
  })
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
