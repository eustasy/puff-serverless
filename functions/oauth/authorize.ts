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

import { hasConsentFor, upsertConsent } from "../../src/oauth-consents.js"
import { oauthRedirectErrorUrl } from "../../src/oauth.js"
import {
  authenticatedUserId,
  buildConsentPage,
  issueCodeAndRedirect,
  readParams,
  redirectToClient,
  redirectToLogin,
  resolveOrgContext,
  staticErrorPage,
  validateRequest,
} from "../../src/utilities/oauth-authorize.js"

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
