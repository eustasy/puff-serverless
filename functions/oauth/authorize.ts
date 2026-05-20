// OAuth 2.1 / OIDC Authorization endpoint. The user-facing entry point: a
// client app redirects the user here, Puff authenticates the user (via the
// session cookie or by sending them through /login), optionally shows a
// consent screen, then redirects back to the client with an authorization
// code in the query string.
//
// Validation order matters — the redirect_uri is the only thing standing
// between us and an open redirect, so we VALIDATE both client_id and
// redirect_uri before we ever redirect anywhere except the static error page.
// After that, OAuth-protocol errors are sent back to the client via the
// redirect (RFC 6749 §4.1.2.1), with `state` echoed back so clients can
// match the response to their original request.

import { escapeHtml } from "../../src/utilities/escape.js"
import { getCookie } from "../../src/utilities/headers.js"
import { setNextCookie, sanitizeNext } from "../../src/utilities/next.js"
import { readAppByClientId } from "../../src/apps.js"
import { createAuthorizationCode } from "../../src/oauth-grants.js"
import { hasConsentFor, upsertConsent } from "../../src/oauth-consents.js"
import {
  oauthRedirectErrorUrl,
  parseScope,
  validateScopes,
} from "../../src/oauth.js"
import { verifyTokenAndGetUser } from "../../src/sessions.js"

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Sign you in",
  profile: "See your name",
  email: "See your verified email address",
  offline_access: "Stay signed in (long-lived refresh access)",
}

interface ParsedRequest {
  response_type: string
  client_id: string
  redirect_uri: string
  scope: string
  state: string | null
  code_challenge: string
  code_challenge_method: string
  nonce: string | null
}

function readParams(source: URLSearchParams): ParsedRequest {
  return {
    response_type: source.get("response_type") || "",
    client_id: source.get("client_id") || "",
    redirect_uri: source.get("redirect_uri") || "",
    scope: source.get("scope") || "",
    state: source.get("state"),
    code_challenge: source.get("code_challenge") || "",
    code_challenge_method: source.get("code_challenge_method") || "",
    nonce: source.get("nonce"),
  }
}

function staticErrorPage(message: string, status = 400): Response {
  const body = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Authorization error</title></head>
  <body>
    <main>
      <h1>Authorization error</h1>
      <p class="result-negative">${escapeHtml(message)}</p>
      <p>If this is unexpected, contact the application owner.</p>
    </main>
  </body>
</html>`
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

function redirectToClient(target: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { "Location": target, "Cache-Control": "no-store" },
  })
}

function redirectToLogin(env: Env, originalUrl: string): Response {
  const url = new URL(originalUrl)
  const path = sanitizeNext(url.pathname + url.search) || "/account"
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/login",
      "Set-Cookie": setNextCookie(env, path),
      "Cache-Control": "no-store",
    },
  })
}

function buildConsentPage(opts: {
  appName: string
  scopes: string[]
  params: ParsedRequest
}): Response {
  const { appName, scopes, params } = opts
  const scopeList = scopes
    .map(
      (s) =>
        `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(
          SCOPE_DESCRIPTIONS[s] || "(unrecognised scope)"
        )}</li>`
    )
    .join("\n")

  // All original parameters are echoed back as hidden inputs on the POST so
  // the consent submission re-validates against the same request shape — the
  // server never trusts client-submitted state alone.
  const hidden = (
    [
      ["response_type", params.response_type],
      ["client_id", params.client_id],
      ["redirect_uri", params.redirect_uri],
      ["scope", params.scope],
      ["state", params.state ?? ""],
      ["code_challenge", params.code_challenge],
      ["code_challenge_method", params.code_challenge_method],
      ["nonce", params.nonce ?? ""],
    ] as const
  )
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(
          value
        )}">`
    )
    .join("\n")

  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Authorize ${escapeHtml(appName)}</title>
  </head>
  <body>
    <main>
      <h1>Authorize ${escapeHtml(appName)}?</h1>
      <p><strong>${escapeHtml(appName)}</strong> is requesting permission to:</p>
      <ul>${scopeList}</ul>
      <form method="POST" action="/oauth/authorize">
${hidden}
        <button type="submit" name="consent" value="approve">Approve</button>
        <button type="submit" name="consent" value="deny">Deny</button>
      </form>
    </main>
  </body>
</html>`
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

interface ValidationContext {
  app: AppRow
  scopes: string[]
}

/**
 * Run the validation steps that don't depend on the user's session. Returns
 * either a Response (the validated request is bad — send the response back
 * directly) or `{ app, scopes }` on success.
 */
async function validateRequest(
  dbClient: DbClient,
  params: ParsedRequest
): Promise<Response | ValidationContext> {
  if (!params.client_id) {
    return staticErrorPage("Missing client_id.")
  }
  const appResult = await readAppByClientId(dbClient, params.client_id)
  if (appResult.error) {
    return staticErrorPage("Server error looking up the application.", 500)
  }
  if (!appResult.success) {
    return staticErrorPage("Unknown client_id.")
  }
  const app = appResult.app

  if (!params.redirect_uri) {
    return staticErrorPage("Missing redirect_uri.")
  }
  if (!app.redirect_uris.includes(params.redirect_uri)) {
    return staticErrorPage("redirect_uri is not registered for this app.")
  }

  // From here onwards, redirect_uri is safe to redirect to.
  if (params.response_type !== "code") {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "unsupported_response_type",
        params.state,
        'Only response_type="code" is supported.'
      )
    )
  }
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "invalid_request",
        params.state,
        "PKCE is required: code_challenge with code_challenge_method=S256."
      )
    )
  }

  const requested = parseScope(params.scope || "openid")
  const { supported, unsupported } = validateScopes(requested)
  if (unsupported.length > 0) {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "invalid_scope",
        params.state,
        `Unsupported scopes: ${unsupported.join(", ")}`
      )
    )
  }
  if (supported.length === 0) {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "invalid_scope",
        params.state,
        "At least one supported scope is required."
      )
    )
  }

  return { app, scopes: supported }
}

async function authenticatedUserId(
  context: Parameters<Handler>[0]
): Promise<string | null> {
  const cookie = await getCookie(
    context.request.headers.get("Cookie"),
    "session_token"
  )
  if (!cookie) return null
  const dbClient = context.data.dbClient
  if (!dbClient) return null
  const result = await verifyTokenAndGetUser(
    dbClient,
    cookie,
    context.request.headers.get("CF-IPCountry"),
    context.request.headers.get("CF-Connecting-IP")
  )
  return result.success ? result.user_uuid : null
}

async function issueCodeAndRedirect(opts: {
  dbClient: DbClient
  user_uuid: string
  app: AppRow
  scopes: string[]
  params: ParsedRequest
}): Promise<Response> {
  const code = await createAuthorizationCode(opts.dbClient, {
    user_uuid: opts.user_uuid,
    app_uuid: opts.app.app_uuid,
    scopes: opts.scopes,
    redirect_uri: opts.params.redirect_uri,
    code_challenge: opts.params.code_challenge,
    code_challenge_method: opts.params.code_challenge_method,
    nonce: opts.params.nonce,
  })
  if (code.error || !code.success) {
    return redirectToClient(
      oauthRedirectErrorUrl(
        opts.params.redirect_uri,
        "server_error",
        opts.params.state,
        "Could not issue authorization code."
      )
    )
  }
  const url = new URL(opts.params.redirect_uri)
  url.searchParams.set("code", code.code)
  if (opts.params.state) url.searchParams.set("state", opts.params.state)
  return redirectToClient(url.toString())
}

export const onRequestGet: Handler = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient
  if (!dbClient) return staticErrorPage("Database unavailable.", 503)

  const params = readParams(new URL(request.url).searchParams)
  const validation = await validateRequest(dbClient, params)
  if (validation instanceof Response) return validation
  const { app, scopes } = validation

  const user_uuid = await authenticatedUserId(context)
  if (!user_uuid) {
    return redirectToLogin(env, request.url)
  }

  const consent = await hasConsentFor(dbClient, user_uuid, app.app_uuid, scopes)
  if (consent.error) {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "server_error",
        params.state,
        "Consent check failed."
      )
    )
  }
  if (consent.success && consent.covered) {
    return issueCodeAndRedirect({
      dbClient,
      user_uuid,
      app,
      scopes,
      params,
    })
  }

  return buildConsentPage({ appName: app.app_name, scopes, params })
}

export const onRequestPost: Handler = async (context) => {
  const { request, data } = context
  const dbClient = data.dbClient
  if (!dbClient) return staticErrorPage("Database unavailable.", 503)

  let form: URLSearchParams
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return staticErrorPage("Could not parse form submission.")
  }
  const params = readParams(form)
  const decision = form.get("consent") || ""

  const validation = await validateRequest(dbClient, params)
  if (validation instanceof Response) return validation
  const { app, scopes } = validation

  const user_uuid = await authenticatedUserId(context)
  if (!user_uuid) {
    // POST without a session: send them to login, then back to GET. Don't
    // preserve the form body — it'll be reconstructed from query params after
    // login since the consent page POSTs to the same URL.
    return redirectToClient("/login", 303)
  }

  if (decision !== "approve") {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "access_denied",
        params.state,
        "User denied the request."
      )
    )
  }

  const consent = await upsertConsent(dbClient, user_uuid, app.app_uuid, scopes)
  if (consent.error) {
    return redirectToClient(
      oauthRedirectErrorUrl(
        params.redirect_uri,
        "server_error",
        params.state,
        "Could not record consent."
      )
    )
  }

  return issueCodeAndRedirect({ dbClient, user_uuid, app, scopes, params })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, POST" },
  })
