import { escapeHtml } from "./escape.js"
import { getCookie } from "./headers.js"
import { setNextCookie, sanitizeNext } from "./next.js"
import { readAppByClientId } from "../apps.js"
import { createAuthorizationCode } from "../oauth-grants.js"
import { oauthRedirectErrorUrl, parseScope, validateScopes } from "../oauth.js"
import { verifyTokenAndGetUser } from "../sessions.js"
import { findEligibleOrgs, isLicensed, isUserInOrg } from "../entitlements.js"

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Sign you in",
  profile: "See your name",
  email: "See your verified email address",
  offline_access: "Stay signed in (long-lived refresh access)",
}

export interface ParsedRequest {
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

/** Extracts OAuth request parameters from URLSearchParams, defaulting missing fields to "". */
export function readParams(source: URLSearchParams): ParsedRequest {
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

/**
 * Error page rendered directly to the browser (not redirected to the client).
 * Used before redirect_uri is validated — once validated, errors go via
 * redirectToClient so the client app can handle them.
 */
export function renderAuthorizeErrorPage(message: string, status = 400): Response {
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

/** Redirects to the OAuth client's redirect_uri (or any validated URL) with Cache-Control: no-store. */
export function redirectToClient(target: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { Location: target, "Cache-Control": "no-store" },
  })
}

/** Sends the user to /login, setting the next-cookie so they return to the authorize URL after authenticating. */
export function redirectToLogin(env: Env, originalUrl: string): Response {
  const url = new URL(originalUrl)
  const path = sanitizeNext(url.pathname + url.search) || "/account"
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie": setNextCookie(env, path),
      "Cache-Control": "no-store",
    },
  })
}

/** Renders the consent screen; echoes original parameters as hidden inputs so the POST re-validates against the same request shape. */
export function buildConsentPage(opts: {
  appName: string
  scopes: string[]
  params: ParsedRequest
  orgs?: { org_uuid: string; org_name: string }[]
}): Response {
  const { appName, scopes, params, orgs } = opts
  const scopeList = scopes
    .map((s) => `<li><code>${escapeHtml(s)}</code> — ${escapeHtml(SCOPE_DESCRIPTIONS[s] || "(unrecognised scope)")}</li>`)
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
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n")

  // When an org picker is rendered, the hidden `org_uuid` is omitted so the
  // radio choice is the authoritative submission.
  const filteredHidden = orgs && orgs.length > 1 ? hidden.replace(/<input type="hidden" name="org_uuid"[^>]*>\n?/, "") : hidden
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

export interface ValidationContext {
  app: AppRow
  scopes: string[]
}

/**
 * Run the validation steps that don't depend on the user's session. Returns
 * either a Response (the validated request is bad — send the response back
 * directly) or `{ app, scopes }` on success.
 */
export async function validateRequest(dbClient: DbClient, params: ParsedRequest): Promise<Response | ValidationContext> {
  if (!params.client_id) {
    return renderAuthorizeErrorPage("Missing client_id.")
  }
  const appResult = await readAppByClientId(dbClient, params.client_id)
  if (appResult.error) {
    return renderAuthorizeErrorPage("Server error looking up the application.", 500)
  }
  if (!appResult.success) {
    return renderAuthorizeErrorPage("Unknown client_id.")
  }
  const app = appResult.app

  if (!params.redirect_uri) {
    return renderAuthorizeErrorPage("Missing redirect_uri.")
  }
  if (!app.redirect_uris.includes(params.redirect_uri)) {
    return renderAuthorizeErrorPage("redirect_uri is not registered for this app.")
  }

  // From here onwards, redirect_uri is safe to redirect to.
  if (params.response_type !== "code") {
    return redirectToClient(
      oauthRedirectErrorUrl(params.redirect_uri, "unsupported_response_type", params.state, 'Only response_type="code" is supported.')
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
      oauthRedirectErrorUrl(params.redirect_uri, "invalid_scope", params.state, `Unsupported scopes: ${unsupported.join(", ")}`)
    )
  }
  if (supported.length === 0) {
    return redirectToClient(
      oauthRedirectErrorUrl(params.redirect_uri, "invalid_scope", params.state, "At least one supported scope is required.")
    )
  }

  return { app, scopes: supported }
}

/** Returns the user_uuid from the session cookie, or null if the session is absent or invalid. */
export async function authenticatedUserId(context: Parameters<Handler>[0]): Promise<string | null> {
  const cookie = await getCookie(context.request.headers.get("Cookie"), "session_token")
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

export type OrgResolution =
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
export async function resolveOrgContext(dbClient: DbClient, app: AppRow, user_uuid: string, params: ParsedRequest): Promise<OrgResolution> {
  if (app.app_licensing_mode === "none") {
    return { kind: "no_org_needed", org_uuid: null }
  }

  if (params.org_uuid) {
    const member = await isUserInOrg(dbClient, params.org_uuid, user_uuid)
    if (!member.success || !member.member) {
      return {
        kind: "error",
        response: redirectToClient(
          oauthRedirectErrorUrl(params.redirect_uri, "access_denied", params.state, "You are not a member of the requested organisation.")
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
        oauthRedirectErrorUrl(params.redirect_uri, "server_error", params.state, "Could not resolve organisations.")
      ),
    }
  }
  if (eligible.orgs.length === 0) {
    return {
      kind: "error",
      response: redirectToClient(
        oauthRedirectErrorUrl(params.redirect_uri, "access_denied", params.state, "You have no entitlement for this application.")
      ),
    }
  }
  if (eligible.orgs.length === 1) {
    return { kind: "bound", org_uuid: eligible.orgs[0]!.org_uuid }
  }
  return { kind: "pick", orgs: eligible.orgs }
}

/** Creates an authorization code and redirects the client to redirect_uri with code + state; redirects to server_error on failure. */
export async function issueCodeAndRedirect(opts: {
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
      oauthRedirectErrorUrl(opts.params.redirect_uri, "server_error", opts.params.state, "Could not issue authorization code.")
    )
  }
  const url = new URL(opts.params.redirect_uri)
  url.searchParams.set("code", code.code)
  if (opts.params.state) url.searchParams.set("state", opts.params.state)
  return redirectToClient(url.toString())
}
