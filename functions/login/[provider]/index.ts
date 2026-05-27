// Federated-login start endpoint. The /login page links here with the
// provider name in the path; we generate a state + PKCE pair, set them in a
// short-lived cookie, and 302-redirect the user to the provider's
// authorization URL. The provider returns the user to /login/[provider]/callback.

import {
  getProviderConfig,
  getProviderCredentials,
  isProviderName,
  providerRedirectUri,
} from "../../../src/oauth-providers.js"
import { buildAuthorizeUrl } from "../../../src/oauth-outbound.js"
import {
  generatePkcePair,
  generateState,
  setOAuthStateCookie,
} from "../../../src/utilities/oauth-state-cookie.js"
import { errorPage } from "../../../src/utilities/login-provider-index.js"

export const onRequestGet: Handler<"provider"> = async (context) => {
  const provider_name = String(context.params.provider)
  if (!isProviderName(provider_name)) {
    return errorPage("Unknown sign-in provider.", 404)
  }
  const config = getProviderConfig(provider_name)
  if (!config) {
    return errorPage("Unknown sign-in provider.", 404)
  }
  const creds = getProviderCredentials(context.env, config)
  if (!creds) {
    return errorPage(
      "This sign-in provider is not configured on this deployment.",
      404
    )
  }

  const state = generateState()
  const { verifier, challenge } = await generatePkcePair()

  const url = buildAuthorizeUrl({
    provider: config,
    client_id: creds.client_id,
    redirect_uri: providerRedirectUri(context.env, config.name),
    state,
    code_challenge: challenge,
  })

  const stateCookie = setOAuthStateCookie(context.env, {
    provider: config.name,
    state,
    code_verifier: verifier,
  })

  return new Response(null, {
    status: 302,
    headers: {
      "Location": url,
      "Set-Cookie": stateCookie,
      "Cache-Control": "no-store",
    },
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
