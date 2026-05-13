import type { Client } from "pg"

declare global {
  interface RequestData extends Record<string, unknown> {
    dbClient?: Client
    user_uuid?: string
  }

  type Handler<P extends string = string> = PagesFunction<Env, P, RequestData>
}

export {}
