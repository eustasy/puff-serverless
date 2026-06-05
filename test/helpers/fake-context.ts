// Builds a fake Pages Functions `EventContext` for unit-testing the handler
// factories in `src/utilities/*-endpoint.ts` and the OAuth endpoint helpers,
// which take a `context` rather than a bare `dbClient`. It mirrors the inline
// fake in test/hooks/dispatch.test.ts but fills in `params`, `next`, and `env`
// so endpoint handlers can read everything they touch.
//
// `waitUntil` records into `.waited` so a test can flush fire-and-forget work
// (hook dispatch, email sends) with `await Promise.all(ctx.waited)` and assert
// on its effects.
//
// Usage:
//
//   const db = new FakeDb()
//   db.on(/SELECT .../, { rows: [...] })
//   const ctx = fakeContext({
//     data: { dbClient: db.client, orgRoles: ["org:owner"], app },
//     params: { org_uuid: "o1" },
//     request: new Request("https://app.example/x", { method: "POST", body }),
//   })
//   const response = await handler.onRequestPost(ctx)

import { FakeDb } from "./fake-db.js"
import { fakeEnv } from "./fake-env.js"

export interface FakeContextOptions {
  /** Defaults to a GET to https://app.example/. */
  request?: Request
  /** Defaults to an empty Env; pass `fakeEnv({ ... })` for bindings. */
  env?: Env
  /** Route params, e.g. `{ org_uuid: "o1", team_uuid: "t1" }`. */
  params?: Record<string, string | string[]>
  /** `context.data` — `dbClient` defaults to a fresh FakeDb client. */
  data?: Partial<RequestData>
  /** What `context.next()` resolves to. Defaults to an empty 200. */
  next?: () => Promise<Response>
}

export type FakeContext = EventContext<Env, string, RequestData> & {
  /** Promises handed to `waitUntil`, in order — await these to flush async work. */
  waited: Promise<unknown>[]
}

export function fakeContext(opts: FakeContextOptions = {}): FakeContext {
  const waited: Promise<unknown>[] = []
  const data: RequestData = {
    dbClient: new FakeDb().client,
    ...opts.data,
  }
  return {
    request: (opts.request ?? new Request("https://app.example/")) as FakeContext["request"],
    functionPath: "/",
    params: (opts.params ?? {}) as FakeContext["params"],
    data,
    env: (opts.env ?? fakeEnv()) as FakeContext["env"],
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p)
    },
    passThroughOnException: () => {},
    next: opts.next ?? (async () => new Response(null, { status: 200 })),
    waited,
  }
}
