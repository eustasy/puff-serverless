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
  type Envelope<T = {}> =
    | ({ success: true; status: number } & T)
    | { success: false; message: string; status: number }
    | { error: true; message: string; details?: unknown; status: number }
}

export {}
