import { describe, it, expect, vi, beforeEach } from "vitest"
import { fakeContext } from "../helpers/fake-context.js"
import { fakeEnv } from "../helpers/fake-env.js"

// db-middleware opens its own `pg` client (it IS the layer that injects
// dbClient), so the client is mocked at the module level — mirroring
// test/cron.test.ts.
const { connectMock, endMock } = vi.hoisted(() => ({ connectMock: vi.fn(), endMock: vi.fn() }))
vi.mock("pg", () => ({
  Client: class {
    connect = connectMock
    end = endMock
    query = vi.fn()
  },
}))

const { createDbMiddleware } = await import("../../src/utilities/db-middleware.js")

const withHyperdrive = () => fakeEnv({ HYPERDRIVE: { connectionString: "postgres://localhost/test" } } as Partial<Env>)

// The middleware reads context.data.dbClient in its `finally`; start it empty so
// the guard reflects production (where no dbClient exists until connect succeeds).
const ctx = (over: { env?: Env; next?: () => Promise<Response> } = {}) =>
  fakeContext({ env: over.env ?? withHyperdrive(), next: over.next, data: { dbClient: undefined } })

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined)
  endMock.mockReset().mockResolvedValue(undefined)
})

describe("createDbMiddleware", () => {
  it("503s without connecting when the Hyperdrive binding is missing", async () => {
    const response = await createDbMiddleware("db")(ctx({ env: fakeEnv() }))
    expect(response.status).toBe(503)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("connects, exposes the client, runs next, and closes the client", async () => {
    const context = ctx({ next: async () => new Response("downstream", { status: 200 }) })
    const response = await createDbMiddleware("db")(context)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("downstream")
    expect(connectMock).toHaveBeenCalledOnce()
    expect(context.data.dbClient).toBeDefined()
    expect(endMock).toHaveBeenCalledOnce()
  })

  it("500s on a connection failure without trying to close an unopened client", async () => {
    connectMock.mockRejectedValue(new Error("no route to host"))
    const response = await createDbMiddleware("db")(ctx())
    expect(response.status).toBe(500)
    expect(endMock).not.toHaveBeenCalled()
  })

  it("500s when the downstream handler throws, still closing the client", async () => {
    const response = await createDbMiddleware("db")(
      ctx({
        next: async () => {
          throw new Error("handler boom")
        },
      })
    )
    expect(response.status).toBe(500)
    expect(endMock).toHaveBeenCalledOnce()
  })

  it("still returns the response when closing the client throws", async () => {
    endMock.mockRejectedValue(new Error("close failed"))
    const response = await createDbMiddleware("db")(ctx({ next: async () => new Response("ok", { status: 200 }) }))
    expect(response.status).toBe(200)
  })
})
