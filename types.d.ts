declare global {
  type DbClient = import("pg").Client

  interface RequestData extends Record<string, unknown> {
    dbClient?: DbClient
    user_uuid?: string
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
}

export {}
