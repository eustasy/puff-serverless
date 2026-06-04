// `/federated-signup?token=…` — the confirmation page for a fresh signup
// landed via /login/[provider]/callback. It previews the username + email
// Puff intends to create and asks the user to confirm. POST goes to
// `/api/db/federated-signup/confirm`, which consumes the token, creates
// the user, links the identity, and issues a session.
//
// A Pages Function (not under /api/db) so the URL is friendly and the page
// can be discovered by direct navigation. The token data is read from the
// DB inline — same approach as src/cron.ts — because there is no other
// reason for this page to exist in the routing tree.

import { Client } from "pg"
import { escapeHtml } from "../src/utilities/escape.js"
import { readFederatedSignupToken } from "../src/federated-signup-tokens.js"
import { getProviderConfig } from "../src/oauth-providers.js"
import { renderErrorPage } from "../src/utilities/error-page.js"
import { deriveUsername } from "../src/utilities/federated-signup.js"

const errorPage = (message: string, status = 400) => renderErrorPage({ title: "Sign-up", message, status })

export const onRequestGet: Handler = async (context) => {
  const url = new URL(context.request.url)
  const token = url.searchParams.get("token") || ""
  if (!token) return errorPage("Missing sign-up token.", 400)

  if (!context.env?.HYPERDRIVE?.connectionString) {
    return errorPage("Server is not configured.", 503)
  }

  const client = new Client(context.env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    const result = await readFederatedSignupToken(client, token)
    if (!result.success) {
      return errorPage(result.message, result.status)
    }
    const row = result.row
    const config = getProviderConfig(row.provider)
    const providerLabel = config?.display_name ?? row.provider
    const username = deriveUsername(row.display_name, row.email)
    const emailLine = row.email
      ? `<dt>Email</dt><dd>${escapeHtml(row.email)}${row.email_verified ? "" : " <em>(unverified — you'll receive a verification link)</em>"}</dd>`
      : `<dt>Email</dt><dd><em>(none — your provider did not share an email)</em></dd>`

    const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Create your Puff account</title>
  <link rel="stylesheet" href="/assets/main.css">
</head>
<body>
  <div class="container">
    <header><h1>Create your Puff account</h1></header>
    <main>
      <p>You're signing in with <strong>${escapeHtml(providerLabel)}</strong> for the first time. Puff is about to create a new account with the details below.</p>
      <dl>
        <dt>Username</dt><dd>${escapeHtml(username)}</dd>
        ${emailLine}
      </dl>
      <form method="POST" action="/api/db/federated-signup/confirm">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Create account</button>
        <a href="/login">Cancel</a>
      </form>
      <p><small>Already have a Puff account? <a href="/login">Sign in first</a>, then link ${escapeHtml(providerLabel)} from your account page.</small></p>
    </main>
  </div>
</body>
</html>`
    return new Response(body, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  } catch (error) {
    console.error("federated-signup page error:", error)
    return errorPage("Unexpected error. Please try again.", 500)
  } finally {
    try {
      await client.end()
    } catch (endError) {
      console.error("federated-signup page close error:", endError)
    }
  }
}

export const onRequest: Handler = async () => new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
