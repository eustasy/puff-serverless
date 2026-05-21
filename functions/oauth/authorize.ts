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
import {
  findEligibleOrgs,
  isLicensed,
  isUserInOrg,
} from "../../src/entitlements.js"

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
  /** Optional org context — picks one of the user's eligible orgs. */
  org_uuid: string | null
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
    org_uuid: source.get("org_uuid"),
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
  orgs?: { org_uuid: string; org_name: string }[]
}): Response {
  const { appName, scopes, params, orgs } = opts
  const scopeList = scopes
    .map(
      (s) =>
        `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(
          SCOPE_DESCRIPTIONS[s] || "(unrecognised scope)"
        )}</li>`
    )
    .join("\n")
  const orgPicker =
    orgs && orgs.length > 1
      ? `<fieldset>
          <legend>Use this app on behalf of:</legend>
          ${orgs
            .map(
              (org, i) =>
                `<label><input type="radio" name="org_uuid" value="${escapeHtml(
                  org.org_uuid
                )}"${i === 0 ? " required" : ""}> ${escapeHtml(org.org_name)}</label>`
            )
            .join("")}
        </fieldset>`
      : ""

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
      ["org_uuid", params.org_uuid ?? ""],
    ] as const
  )
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(
          value
        )}">`
    )
    .join("\n")

  // When an org picker is rendered, the hidden `org_uuid` is omitted so the
  // radio choice is the authoritative submission.
  const filteredHidden =
    orgs && orgs.length > 1
      ? hidden.replace(/<input type="hidden" name="org_uuid"[^>]*>\n?/, "")
      : hidden
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
${filteredHidden}
        ${orgPicker}
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

type OrgResolution =
  | { kind: "no_org_needed"; org_uuid: null }
  | { kind: "bound"; org_uuid: string }
  | {
      kind: "pick"
      orgs: { org_uuid: string; org_name: string }[]
    }
  | { kind: "error"; response: Response }

/**
 * Resolves the org context for this OAuth request.
 *
 *   - `none`-mode app  → no org context required; org_uuid stays null.
 *   - explicit org_uuid in the request → verified to exist, the user must
 *     belong to it, and (for licensed modes) `isLicensed` must pass.
 *   - no explicit org → look at the user's eligible orgs:
 *       0  → access_denied (no entitlements anywhere).
 *       1  → bind that single org automatically.
 *       2+ → show the consent page with an org picker; the POST will carry
 *            an org_uuid form field.
 *
 * For `floating`-mode apps, allocation happens at /token time — the
 * isLicensed gate here only requires that a pool is configured (so the
 * caller might still be turned away then if the pool is full).
 */
async function resolveOrgContext(
  dbClient: DbClient,
  app: AppRow,
  user_uuid: string,
  params: ParsedRequest
): Promise<OrgResolution> {
  if (app.app_licensing_mode === "none") {
    return { kind: "no_org_needed", org_uuid: null }
  }

  if (params.org_uuid) {
    const member = await isUserInOrg(dbClient, params.org_uuid, user_uuid)
    if (!member.success || !member.member) {
      return {
        kind: "error",
        response: redirectToClient(
          oauthRedirectErrorUrl(
            params.redirect_uri,
            "access_denied",
            params.state,
            "You are not a member of the requested organisation."
          )
        ),
      }
    }
    // For floating apps, accept the binding without confirming a free seat —
    // the pool check runs at /token time; allocating here would hold a seat
    // for the entire consent screen.
    if (app.app_licensing_mode !== "floating") {
      const lic = await isLicensed(dbClient, app, user_uuid, params.org_uuid)
      if (!lic.success || !lic.licensed) {
        return {
          kind: "error",
          response: redirectToClient(
            oauthRedirectErrorUrl(
              params.redirect_uri,
              "access_denied",
              params.state,
              "No entitlement for this application in that organisation."
            )
          ),
        }
      }
    }
    return { kind: "bound", org_uuid: params.org_uuid }
  }

  const eligible = await findEligibleOrgs(dbClient, app.app_uuid, user_uuid)
  if (!eligible.success) {
    return {
      kind: "error",
      response: redirectToClient(
        oauthRedirectErrorUrl(
          params.redirect_uri,
          "server_error",
          params.state,
          "Could not resolve organisations."
        )
      ),
    }
  }
  if (eligible.orgs.length === 0) {
    return {
      kind: "error",
      response: redirectToClient(
        oauthRedirectErrorUrl(
          params.redirect_uri,
          "access_denied",
          params.state,
          "You have no entitlement for this application."
        )
      ),
    }
  }
  if (eligible.orgs.length === 1) {
    return { kind: "bound", org_uuid: eligible.orgs[0]!.org_uuid }
  }
  return { kind: "pick", orgs: eligible.orgs }
}

async function issueCodeAndRedirect(opts: {
  dbClient: DbClient
  user_uuid: string
  app: AppRow
  scopes: string[]
  params: ParsedRequest
  org_uuid: string | null
}): Promise<Response> {
  const code = await createAuthorizationCode(opts.dbClient, {
    user_uuid: opts.user_uuid,
    app_uuid: opts.app.app_uuid,
    org_uuid: opts.org_uuid,
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

  const orgResolution = await resolveOrgContext(
    dbClient,
    app,
    user_uuid,
    params
  )
  if (orgResolution.kind === "error") return orgResolution.response

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

  if (consent.success && consent.covered && orgResolution.kind !== "pick") {
    return issueCodeAndRedirect({
      dbClient,
      user_uuid,
      app,
      scopes,
      params,
      org_uuid: orgResolution.kind === "bound" ? orgResolution.org_uuid : null,
    })
  }

  return buildConsentPage({
    appName: app.app_name,
    scopes,
    params,
    orgs: orgResolution.kind === "pick" ? orgResolution.orgs : undefined,
  })
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

  const orgResolution = await resolveOrgContext(
    dbClient,
    app,
    user_uuid,
    params
  )
  if (orgResolution.kind === "error") return orgResolution.response
  if (orgResolution.kind === "pick") {
    // The picker form failed to submit a choice — re-render it.
    return buildConsentPage({
      appName: app.app_name,
      scopes,
      params,
      orgs: orgResolution.orgs,
    })
  }
  const bound_org_uuid =
    orgResolution.kind === "bound" ? orgResolution.org_uuid : null

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

  return issueCodeAndRedirect({
    dbClient,
    user_uuid,
    app,
    scopes,
    params,
    org_uuid: bound_org_uuid,
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, POST" },
  })
