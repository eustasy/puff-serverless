// Federated-login callback. The provider redirects the user here with
// `code` + `state` in the query string (or `error` if the user denied
// consent). We verify the state against the cookie we set on the way out,
// exchange the code for an access token, fetch the user's identity, then
// decide how to land them in Puff:
//
//   - An existing (provider, provider_user_id) match logs them in directly
//     (bypassing the 2FA gate, matching how passkey login works).
//   - A request with a current Puff session links the identity to that user
//     and redirects to /account.
//   - Anyone else gets a federated_signup_token and lands on
//     /federated-signup?token=… to confirm account creation.

import {
  getProviderConfig,
  getProviderCredentials,
  isProviderName,
  providerRedirectUri,
} from "../../../src/oauth-providers.js"
import { exchangeCode, fetchUserIdentity } from "../../../src/oauth-outbound.js"
import {
  clearOAuthStateCookie,
  readOAuthStateCookie,
} from "../../../src/utilities/oauth-state-cookie.js"
import {
  findByProvider,
  linkExternalIdentity,
  updateLastUsed,
} from "../../../src/external-identities.js"
import { createFederatedSignupToken } from "../../../src/federated-signup-tokens.js"
import { createSession, verifyTokenAndGetUser } from "../../../src/sessions.js"
import { getCookie } from "../../../src/utilities/headers.js"
import { clearNextCookie, readNext } from "../../../src/utilities/next.js"
import { emitFromContext } from "../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../src/hooks/events.js"

function errorPage(message: string, status = 400): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in error</title></head>
<body><main>
<h1>Sign-in error</h1>
<p class="result-negative">${message}</p>
<p><a href="/login">Back to sign-in</a></p>
</main></body></html>`
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

function buildSessionCookie(env: Env, session_id: string): string {
  const parts = [
    `session_token=${session_id}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${env.COOKIE_SAMESITE || "Lax"}`,
    `Max-Age=${env.SESSION_MAX_AGE_SECONDS || 2592000}`,
  ]
  if (env.SECURE_COOKIE) parts.push("Secure")
  return parts.join("; ")
}

function redirectTo(target: string, setCookies: string[]): Response {
  const headers = new Headers({
    "Location": target,
    "Cache-Control": "no-store",
  })
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie)
  }
  return new Response(null, { status: 302, headers })
}

export const onRequestGet: Handler<"provider"> = async (context) => {
  const { request, env, data } = context
  const dbClient = data.dbClient!

  const provider_name = String(context.params.provider)
  if (!isProviderName(provider_name)) {
    return errorPage("Unknown sign-in provider.", 404)
  }
  const config = getProviderConfig(provider_name)
  if (!config) return errorPage("Unknown sign-in provider.", 404)

  const url = new URL(request.url)
  const error = url.searchParams.get("error")
  if (error) {
    const description =
      url.searchParams.get("error_description") || "The provider declined."
    const page = errorPage(`Provider error: ${description}`, 400)
    page.headers.append("Set-Cookie", clearOAuthStateCookie(env))
    return page
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) {
    return errorPage("Missing callback parameters.", 400)
  }

  const cookie = await readOAuthStateCookie(request.headers.get("Cookie"))
  if (!cookie || cookie.provider !== provider_name || cookie.state !== state) {
    return errorPage(
      "Sign-in session expired or was tampered with. Please try again.",
      400
    )
  }

  const creds = getProviderCredentials(env, config)
  if (!creds) {
    return errorPage(
      "This sign-in provider is not configured on this deployment.",
      404
    )
  }

  const exchanged = await exchangeCode({
    provider: config,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    code,
    redirect_uri: providerRedirectUri(env, config.name),
    code_verifier: cookie.code_verifier,
  })
  if (!exchanged.success) {
    return errorPage(exchanged.message, exchanged.status)
  }

  const fetched = await fetchUserIdentity(
    config,
    exchanged.access_token,
    exchanged.id_token
  )
  if (!fetched.success) {
    return errorPage(fetched.message, fetched.status)
  }
  const identity = fetched.identity

  // 1) Existing link → log in directly.
  const linked = await findByProvider(
    dbClient,
    provider_name,
    identity.provider_user_id
  )
  if (linked.error) {
    return errorPage("Lookup failed.", 500)
  }
  if (linked.success && linked.identity) {
    const sessionResult = await createSession(
      dbClient,
      linked.identity.user_uuid,
      request.headers.get("User-Agent") || "",
      request.headers.get("CF-Connecting-IP") || "",
      request.headers.get("CF-IPCountry") || ""
    )
    if (!sessionResult.success) {
      return errorPage("Could not start your session.", 500)
    }
    await updateLastUsed(dbClient, provider_name, identity.provider_user_id)
    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_LOGIN_SUCCESS,
      actor_user_uuid: linked.identity.user_uuid,
      target_user_uuid: linked.identity.user_uuid,
      event_metadata: { provider: provider_name },
    })

    const next = await readNext(request)
    const setCookies = [
      clearOAuthStateCookie(env),
      buildSessionCookie(env, sessionResult.session_id),
    ]
    if (next) setCookies.push(clearNextCookie(env))
    return redirectTo(next || "/account", setCookies)
  }

  // 2) Authenticated caller → link the identity.
  const sessionCookieValue = await getCookie(
    request.headers.get("Cookie"),
    "session_token"
  )
  if (sessionCookieValue) {
    const verified = await verifyTokenAndGetUser(
      dbClient,
      sessionCookieValue,
      request.headers.get("CF-IPCountry"),
      request.headers.get("CF-Connecting-IP")
    )
    if (verified.success) {
      const link = await linkExternalIdentity(dbClient, {
        user_uuid: verified.user_uuid,
        provider: provider_name,
        provider_user_id: identity.provider_user_id,
        email: identity.email,
        display_name: identity.display_name,
      })
      if (link.error) {
        return errorPage("Could not link your account.", 500)
      }
      if (!link.success) {
        return errorPage(link.message, link.status)
      }
      await emitFromContext(context, {
        event_type: EVENTS.ACCOUNT_EXTERNAL_IDENTITY_LINKED,
        actor_user_uuid: verified.user_uuid,
        target_user_uuid: verified.user_uuid,
        target_label: `${provider_name}:${identity.provider_user_id}`,
      })
      return redirectTo("/account", [clearOAuthStateCookie(env)])
    }
  }

  // 3) No match, no session → confirm signup.
  const signupToken = await createFederatedSignupToken(dbClient, {
    provider: provider_name,
    provider_user_id: identity.provider_user_id,
    email: identity.email,
    email_verified: identity.email_verified,
    display_name: identity.display_name,
  })
  if (!signupToken.success) {
    return errorPage("Could not start your signup.", 500)
  }
  return redirectTo(
    `/federated-signup?token=${encodeURIComponent(signupToken.token)}`,
    [clearOAuthStateCookie(env)]
  )
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
