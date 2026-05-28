declare global {
  type DbClient = import("pg").Client

  // OAuth/OIDC signing-key bindings. Active material lives in the
  // `KV_OAUTH_KEYS` KV namespace so the rotation cron can write a fresh
  // keypair at runtime (Wrangler secrets are immutable to the running
  // Worker). The Wrangler-secret pair (`OAUTH_SIGNING_KEY_PRIVATE` /
  // `OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC`) is the migration fallback —
  // `src/oauth-keys.ts` reads KV first and falls back to the env vars when
  // KV is empty (local dev, post-provision seed). After ≥ one successful
  // rotation in production the env-var path can be removed.
  //
  // `OPERATOR_USER_UUIDS` (comma- or whitespace-separated) gates the
  // `/api/db/auth/admin/*` endpoints — see `functions/api/db/auth/admin/`.
  // `OAUTH_KEY_ROTATION_INTERVAL_DAYS` (default 7) bounds the minimum age
  // before the daily cron rotates again — see `src/oauth-keys-rotation.ts`.
  //
  // Declared here so the codebase typechecks regardless of whether the
  // bindings exist in the current Wrangler deployment.
  interface Env {
    KV_OAUTH_KEYS?: KVNamespace
    OAUTH_SIGNING_KEY_PRIVATE?: string
    OAUTH_SIGNING_KEY_PREVIOUS_PUBLIC?: string
    OAUTH_KEY_ROTATION_INTERVAL_DAYS?: string
    OPERATOR_USER_UUIDS?: string
    // Billing (Phase 9). Both are Wrangler secrets, declared optional so the
    // codebase typechecks whether or not the binding is present in a given
    // deployment (e.g. local dev without billing configured).
    STRIPE_SECRET_KEY?: string
    STRIPE_WEBHOOK_SIGNING_SECRET?: string
  }

  interface RequestData extends Record<string, unknown> {
    dbClient?: DbClient
    user_uuid?: string
    // Set by the organisation / team `_middleware.ts` for the matching route
    // depth: the caller's roles in the `[org_uuid]` / `[team_uuid]` of the path.
    orgRoles?: string[]
    teamRoles?: string[]
    // Set by `apps/[app_uuid]/_middleware.ts`: the resolved app row for the
    // entitlement endpoints under that tree.
    app?: AppRow
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
    org_locale: string | null
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
    app_licensing_mode: "none" | "seat" | "usage" | "floating"
    // Default trial length (days) applied when an org first subscribes to a
    // billed app. NULL = no trial. Read by the subscribe flow (Phase 9).
    app_default_trial_days: number | null
    app_created_at: Date
  }

  interface OAuthGrantRow {
    grant_value: string
    grant_type: "authorization_code" | "refresh_token"
    user_uuid: string
    app_uuid: string
    org_uuid: string | null
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

  interface AppFloatingSessionRow {
    app_uuid: string
    org_uuid: string
    user_uuid: string
    heartbeat_at: Date
    expires_at: Date
    created_at: Date
  }

  interface ExternalIdentityRow {
    user_uuid: string
    provider: string
    provider_user_id: string
    email: string | null
    display_name: string | null
    linked_at: Date
    last_used_at: Date | null
  }

  interface FederatedSignupTokenRow {
    token_value: string
    provider: string
    provider_user_id: string
    email: string | null
    email_verified: boolean
    display_name: string | null
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

  // Billing (Phase 9) — source of truth: sql/billing_*.sql, sql/subscriptions.sql,
  // sql/invoices.sql, sql/usage_*.sql. `pg` decodes DECIMAL as a string and INT
  // as a number, hence `quantity: string` but `amount_cents: number`.

  interface BillingCustomerRow {
    org_uuid: string
    provider: string
    provider_customer_id: string
    default_payment_method_id: string | null
    tax_id: string | null
    billing_email: string | null
  }

  interface SubscriptionRow {
    subscription_uuid: string
    org_uuid: string
    app_uuid: string
    provider: string
    provider_subscription_id: string
    status:
      | "trialing"
      | "active"
      | "past_due"
      | "canceled"
      | "paused"
      | "incomplete"
    tier: string
    current_period_start: Date
    current_period_end: Date
    cancel_at: Date | null
    canceled_at: Date | null
    trial_end: Date | null
    created_at: Date
  }

  interface InvoiceRow {
    invoice_uuid: string
    org_uuid: string
    subscription_uuid: string | null
    provider: string
    provider_invoice_id: string
    status: "draft" | "open" | "paid" | "void" | "uncollectible"
    amount_cents: number
    currency: string
    period_start: Date
    period_end: Date
    due_at: Date | null
    paid_at: Date | null
    hosted_invoice_url: string | null
    created_at: Date
  }

  interface BillingPricingRow {
    pricing_uuid: string
    app_uuid: string
    tier: string
    price_cents: number
    currency: string
    billing_interval: "month" | "year"
    provider_price_id: string
  }

  interface UsageEventRow {
    event_uuid: string
    app_uuid: string
    org_uuid: string
    user_uuid: string | null
    metric: string
    quantity: string
    occurred_at: Date
    received_at: Date
    idempotency_key: string
  }

  interface UsageRollupRow {
    app_uuid: string
    org_uuid: string
    metric: string
    day: Date
    quantity: string
    synced_at: Date | null
  }

  interface AuditEventRow {
    event_uuid: string
    event_type: string
    event_severity:
      | "debug"
      | "info"
      | "notice"
      | "warning"
      | "alert"
      | "critical"
    event_outcome: "success" | "failure" | "attempt"
    actor_user_uuid: string | null
    actor_ip: string | null
    actor_user_agent: string | null
    target_user_uuid: string | null
    target_org_uuid: string | null
    target_team_uuid: string | null
    target_app_uuid: string | null
    target_label: string | null
    event_metadata: string | null
    created_at: Date
  }
}

export {}
