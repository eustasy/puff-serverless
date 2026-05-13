import type { Client } from "pg"

declare global {
  interface RequestData extends Record<string, unknown> {
    dbClient?: Client
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
}

export {}
