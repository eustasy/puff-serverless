// Federated-login provider registry. Each provider declares the OAuth
// endpoints, the scopes Puff requests, the env-var names that hold its
// client credentials, and a `normaliseUserinfo` callback that translates the
// provider's userinfo JSON into Puff's normalised shape.
//
// Provider configs are static and shipped with the code; credentials are
// per-deployment env vars (operator sets these via wrangler secrets). A
// provider with no credentials configured is reported as "not configured",
// so /login/github simply 404s when the operator hasn't set up GitHub.

/** The three providers Puff knows how to federate with. */
export const PROVIDERS = ["github", "google", "microsoft"] as const
export type ProviderName = (typeof PROVIDERS)[number]

/** Type guard: returns true when value is one of the known provider name strings. */
export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value)
}

/** Normalised identity Puff stores in `external_identities`. */
export interface NormalisedIdentity {
  provider_user_id: string
  email: string | null
  email_verified: boolean
  display_name: string | null
}

export interface ProviderConfig {
  name: ProviderName
  display_name: string
  authorize_url: string
  token_url: string
  userinfo_url: string
  /** Space-joined into the `scope` parameter. */
  scopes: readonly string[]
  /** Env var holding the client_id. Operator sets via wrangler. */
  client_id_env: string
  /** Env var holding the client_secret. Operator sets via wrangler secret put. */
  client_secret_env: string
  /**
   * Pulls the normalised identity out of the provider's userinfo response.
   * Receives the parsed JSON; may also receive a follow-up `emails` payload
   * for providers (GitHub) where the primary verified email lives at a
   * separate URL, and the raw `id_token` string from the token endpoint
   * for providers (Microsoft) where the issuing tenant decides verification.
   */
  normaliseUserinfo: (userinfo: unknown, emails?: unknown, idToken?: string) => NormalisedIdentity | null
  /**
   * Optional: providers (GitHub) require a separate fetch to discover the
   * primary verified email when /user does not surface one.
   */
  emails_url?: string
}

/**
 * Microsoft's special tenant ID for personal Microsoft Accounts (Outlook,
 * Hotmail, Xbox). A `tid` claim equal to this on an ID token means the
 * issuing tenant is the consumer MSA service, where users can change
 * their primary email without re-verifying it. Any other `tid` is a
 * work/school tenant where the email is the verified UPN.
 */
const PERSONAL_MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad"

/**
 * Reads the `tid` (tenant ID) claim out of an unsigned-decoded ID token.
 * Returns null if the token is malformed or carries no `tid`. NO signature
 * verification — the token came back over TLS in the immediate response to
 * our own token-endpoint POST, so trusting the body is fine for the
 * verification-flag use case. Anything that needs cryptographic trust must
 * use `src/oauth-jwt.ts` instead.
 */
function readIdTokenTenant(idToken: string): string | null {
  const parts = idToken.split(".")
  if (parts.length !== 3) return null
  try {
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((parts[1]!.length + 3) % 4)
    const json = atob(padded)
    const payload = JSON.parse(json) as { tid?: unknown }
    return typeof payload.tid === "string" ? payload.tid : null
  } catch {
    return null
  }
}

// --- Per-provider userinfo extractors --------------------------------------

interface GitHubUser {
  id: number | string
  login?: string | null
  name?: string | null
  email?: string | null
}
interface GitHubEmail {
  email: string
  primary: boolean
  verified: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function coerceProviderField(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function extractGitHub(userinfo: unknown, emails?: unknown): NormalisedIdentity | null {
  if (!isObject(userinfo)) return null
  const u = userinfo as unknown as GitHubUser
  const id = coerceProviderField(u.id)
  if (!id) return null

  let email = coerceProviderField(u.email)
  let email_verified = false
  // /user.email is often null for users who hide it. The /user/emails fetch
  // gives us the authoritative list — pick the primary verified one.
  if (Array.isArray(emails)) {
    const arr = emails as GitHubEmail[]
    const primary = arr.find((e) => e?.primary && e?.verified)
    const anyVerified = arr.find((e) => e?.verified)
    const chosen = primary ?? anyVerified
    if (chosen) {
      email = chosen.email
      email_verified = true
    }
  } else if (email) {
    // Without /user/emails GitHub gives no verification flag — treat as
    // unverified.
    email_verified = false
  }

  return {
    provider_user_id: id,
    email,
    email_verified,
    display_name: coerceProviderField(u.name) ?? coerceProviderField(u.login),
  }
}

interface GoogleUser {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string | null
}

function extractGoogle(userinfo: unknown): NormalisedIdentity | null {
  if (!isObject(userinfo)) return null
  const u = userinfo as GoogleUser
  if (typeof u.sub !== "string" || u.sub === "") return null
  return {
    provider_user_id: u.sub,
    email: coerceProviderField(u.email),
    email_verified: u.email_verified === true,
    display_name: coerceProviderField(u.name),
  }
}

interface MicrosoftUser {
  sub?: string
  email?: string | null
  name?: string | null
}

function extractMicrosoft(userinfo: unknown, _emails?: unknown, idToken?: string): NormalisedIdentity | null {
  if (!isObject(userinfo)) return null
  const u = userinfo as MicrosoftUser
  if (typeof u.sub !== "string" || u.sub === "") return null
  const email = coerceProviderField(u.email)
  // Microsoft's `/oidc/userinfo` does not carry an `email_verified` claim, so
  // we read the ID token's `tid` (tenant ID) to decide: a `tid` other than
  // the personal-MSA tenant means a work/school tenant where the email is
  // the verified UPN. Personal-MSA emails (Outlook / Hotmail / Xbox) and any
  // unparseable / missing ID token stay unverified, so the user lands in
  // Puff's standard email-verification flow.
  let email_verified = false
  if (email && idToken) {
    const tid = readIdTokenTenant(idToken)
    if (tid && tid !== PERSONAL_MSA_TENANT_ID) {
      email_verified = true
    }
  }
  return {
    provider_user_id: u.sub,
    email,
    email_verified,
    display_name: coerceProviderField(u.name),
  }
}

// --- Provider registry -----------------------------------------------------

const REGISTRY: Record<ProviderName, ProviderConfig> = {
  github: {
    name: "github",
    display_name: "GitHub",
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    userinfo_url: "https://api.github.com/user",
    emails_url: "https://api.github.com/user/emails",
    scopes: ["read:user", "user:email"],
    client_id_env: "OAUTH_GITHUB_CLIENT_ID",
    client_secret_env: "OAUTH_GITHUB_CLIENT_SECRET",
    normaliseUserinfo: extractGitHub,
  },
  google: {
    name: "google",
    display_name: "Google",
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    client_id_env: "OAUTH_GOOGLE_CLIENT_ID",
    client_secret_env: "OAUTH_GOOGLE_CLIENT_SECRET",
    normaliseUserinfo: extractGoogle,
  },
  microsoft: {
    name: "microsoft",
    display_name: "Microsoft",
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfo_url: "https://graph.microsoft.com/oidc/userinfo",
    scopes: ["openid", "email", "profile"],
    client_id_env: "OAUTH_MICROSOFT_CLIENT_ID",
    client_secret_env: "OAUTH_MICROSOFT_CLIENT_SECRET",
    normaliseUserinfo: extractMicrosoft,
  },
}

/** Resolve a provider name to its static config, or null if unknown. */
export function getProviderConfig(name: string): ProviderConfig | null {
  if (!isProviderName(name)) return null
  return REGISTRY[name]
}

/**
 * Reads the client credentials for a provider out of the environment. Returns
 * null when either env var is missing — the caller treats that as "this
 * provider is not configured on this deployment" and 404s the request.
 */
export function getProviderCredentials(env: Env, config: ProviderConfig): { client_id: string; client_secret: string } | null {
  const client_id = (env as unknown as Record<string, string | undefined>)[config.client_id_env]
  const client_secret = (env as unknown as Record<string, string | undefined>)[config.client_secret_env]
  if (!client_id || !client_secret) return null
  return { client_id, client_secret }
}

/**
 * Convenience: returns the providers this deployment has credentials for.
 * Used by the /login page to decide which provider buttons to render.
 */
export function listConfiguredProviders(env: Env): ProviderConfig[] {
  return PROVIDERS.map((name) => REGISTRY[name]).filter((config) => getProviderCredentials(env, config) !== null)
}

/** Builds the redirect_uri the provider should return the user to. */
export function providerRedirectUri(env: Env, name: ProviderName): string {
  const base = (env.APP_URL || "").replace(/\/$/, "")
  return `${base}/login/${name}/callback`
}
