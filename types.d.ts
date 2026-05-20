declare global {
  type DbClient = import("pg").Client

  // OAuth/OIDC signing-key bindings. The private key is a Wrangler secret
  // (set via `wrangler secret put OAUTH_SIGNING_KEY_PRIVATE`); the optional
  // previous-public is a non-secret string the operator sets via dashboard or
  // `wrangler secret put` during a rotation overlap window. Declared here so
  // the codebase typechecks regardless of whether the secret has been pushed
  // to the current Wrangler deployment.
  interface Env {
    OAUTH_SIGNING_KEY_PRIVATE: string
    OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC?: string
  }

  interface RequestData extends Record<string, unknown> {
    dbClient?: DbClient
    user_uuid?: string
    // Set by the organisation / team `_middleware.ts` for the matching route
    // depth: the caller's roles in the `[org_uuid]` / `[team_uuid]` of the path.
    orgRoles?: string[]
    teamRoles?: string[]
  }

  type Handler<P extends string = string> = PagesFunction<Env, P, RequestData>

  // Canonical return shape for src/* helpers. Three discriminated variants:
  //   { success: true, status, ...T }              -- ran successfully
  //   { success: false, message, status }          -- validation / business-rule failure
  //   { error: true, message, details?, status }   -- DB / system error
  //
  // The `error?: undefined` / `success?: undefined` markers let callers
  // narrow with `if (result.error)` and `if (result.success)` patterns
  // without needing `"error" in result` checks.
  type Envelope<T = {}> =
    | ({ success: true; error?: never; status: number } & T)
    | { success: false; error?: never; message: string; status: number }
    | {
        success?: never
        error: true
        message: string
        details?: unknown
        status: number
      }

  // Pre-status legacy variant used by src/tokens.ts helpers. No `status` field.
  // Phase 2 annotates the existing shape; aligning these with Envelope is its own follow-up.
  type TokenEnvelope<T = {}> =
    | ({ success: true; error?: never } & T)
    | {
        success?: never
        error: true
        message: string
        details?: unknown
      }

  // DB row shapes — source of truth: sql/*.sql schema files.

  interface UserRow {
    user_uuid: string
    user_name: string
    user_created_at: Date
    user_last_login: Date | null
  }

  interface EmailRow {
    user_uuid: string
    email_address: string
    is_primary: boolean
    is_verified: boolean
    verified_at: Date | null
  }

  interface TwoFactorRow {
    user_uuid: string
    secret_type: string
    secret_value: string
    secret_name: string | null
    is_enabled: boolean
    secret_created_at: Date
    secret_last_used: Date | null
  }

  interface SessionRow {
    session_id: string
    created_at: Date
    expires_at: Date
    is_active: boolean
    user_agent: string | null
    ip_address: string | null
    ip_country: string | null
  }

  interface TokenRow {
    user_uuid: string
    email_address: string | null
    token_type: string
    expires_at: Date
    is_used: boolean
  }

  interface PasswordSecretRow {
    secret_value: string
    secret_type: string
  }

  interface PasskeyRow {
    passkey_uuid: string
    user_uuid: string
    credential_id: string
    public_key: string
    counter: number
    transports: string[] | null
    passkey_name: string | null
    created_at: Date
    last_used_at: Date | null
    is_enabled: boolean
  }

  // Shared columns for every *_key_values table.
  interface KeyValueRowCommon {
    kv_key: string
    kv_value: string
    owner_user_uuid: string | null
    owner_org_uuid: string | null
    owner_app_uuid: string | null
    owner_id: string
    created_at: Date
    updated_at: Date
  }

  interface UserKeyValueRow extends KeyValueRowCommon {
    user_uuid: string
  }

  interface TeamKeyValueRow extends KeyValueRowCommon {
    team_uuid: string
  }

  interface OrganisationKeyValueRow extends KeyValueRowCommon {
    org_uuid: string
  }

  interface OrgRoleKeyValueRow extends KeyValueRowCommon {
    org_uuid: string
    role: string
  }

  interface TeamRoleKeyValueRow extends KeyValueRowCommon {
    team_uuid: string
    role: string
  }

  interface AppKeyValueRow extends KeyValueRowCommon {
    app_uuid: string
  }

  interface OrganisationRow {
    org_uuid: string
    org_name: string
    org_active: boolean
    org_created_at: Date
    org_created_by: string | null
  }

  interface TeamRow {
    team_uuid: string
    org_uuid: string
    team_name: string
    team_created_at: Date
  }

  interface OrganisationMemberRow {
    org_uuid: string
    user_uuid: string
    role: string
    added_at: Date
    added_by: string | null
  }

  interface TeamMemberRow {
    team_uuid: string
    user_uuid: string
    role: string
    added_at: Date
    added_by: string | null
  }

  interface OrganisationInvitationRow {
    invitation_token: string
    org_uuid: string
    email_address: string
    roles: string[]
    invited_by: string | null
    created_at: Date
    expires_at: Date
    is_used: boolean
  }

  interface AppRow {
    app_uuid: string
    app_name: string
    client_id: string
    client_secret: string
    redirect_uris: string[]
    app_active: boolean
    app_created_at: Date
  }

  interface OAuthGrantRow {
    grant_value: string
    grant_type: "authorization_code" | "refresh_token"
    user_uuid: string
    app_uuid: string
    scopes: string[]
    redirect_uri: string | null
    code_challenge: string | null
    code_challenge_method: string | null
    nonce: string | null
    parent_grant_value: string | null
    expires_at: Date
    created_at: Date
    is_used: boolean
  }

  interface OAuthConsentRow {
    user_uuid: string
    app_uuid: string
    scopes: string[]
    granted_at: Date
  }
}

export {}
