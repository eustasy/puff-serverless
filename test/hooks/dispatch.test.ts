import { describe, it, expect, vi, beforeEach } from "vitest"
import type { EmitContext, HookListener } from "../../src/hooks/types.js"
import { FakeDb } from "../helpers/fake-db.js"

// Swap in a controllable set of listeners for the dispatcher under test.
// `vi.hoisted` is required so the array reference is shared with the mocked
// module factory below.
const { listeners } = vi.hoisted(() => ({
  listeners: [] as HookListener[],
}))

vi.mock("../../src/hooks/registry.js", () => ({
  getListeners: () => listeners,
}))

const { emit, emitFromContext } = await import("../../src/hooks/dispatch.js")

beforeEach(() => {
  listeners.length = 0
})

function fakeCtx(overrides: Partial<EmitContext> = {}): EmitContext & {
  waited: Promise<unknown>[]
} {
  const waited: Promise<unknown>[] = []
  const headers = new Headers({
    "CF-Connecting-IP": "203.0.113.7",
    "User-Agent": "fake/1",
  })
  return {
    request: { headers } as unknown as Request,
    data: { dbClient: new FakeDb().client, user_uuid: "actor-uuid" },
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p)
    },
    waited,
    ...overrides,
  }
}

describe("emit", () => {
  it("awaits sync listeners and propagates their errors", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("boom"))
    listeners.push({ name: "audit-test", kind: "sync", handle })

    const db = new FakeDb()
    await expect(
      emit(db.client, null, { event_type: "account.login.success" })
    ).rejects.toThrow("boom")
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("hands async listeners to ctx.waitUntil and does not block on them", async () => {
    let resolveWork: () => void
    const work = new Promise<void>((r) => {
      resolveWork = r
    })
    const handle = vi.fn().mockReturnValue(work)
    listeners.push({ name: "webhook", kind: "async", handle })

    const ctx = fakeCtx()
    const db = new FakeDb()
    await emit(db.client, ctx, { event_type: "account.login.success" })

    expect(handle).toHaveBeenCalledTimes(1)
    expect(ctx.waited).toHaveLength(1)
    // The dispatcher returned without awaiting the listener.
    resolveWork!()
    await ctx.waited[0]
  })

  it("swallows async listener errors so the response is not affected", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const handle = vi.fn().mockRejectedValue(new Error("async-fail"))
    listeners.push({ name: "flaky", kind: "async", handle })

    const ctx = fakeCtx()
    const db = new FakeDb()
    await emit(db.client, ctx, { event_type: "account.login.success" })

    await ctx.waited[0] // resolves cleanly because the catch swallows
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("runs async listeners inline when ctx is null", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const handle = vi.fn().mockResolvedValue(undefined)
    listeners.push({ name: "cron-listener", kind: "async", handle })

    const db = new FakeDb()
    await emit(db.client, null, { event_type: "account.login.success" })

    expect(handle).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it("skips a listener whose filter returns false", async () => {
    const handle = vi.fn().mockResolvedValue(undefined)
    listeners.push({
      name: "scoped",
      kind: "sync",
      filter: (e) => e.event_type.startsWith("org."),
      handle,
    })

    const db = new FakeDb()
    await emit(db.client, null, { event_type: "account.login.success" })
    expect(handle).not.toHaveBeenCalled()

    await emit(db.client, null, { event_type: "org.member.added" })
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it("fills in defaults for severity and outcome", async () => {
    let received: unknown
    listeners.push({
      name: "capture",
      kind: "sync",
      handle: async (_db, event) => {
        received = event
      },
    })

    const db = new FakeDb()
    await emit(db.client, null, { event_type: "account.password.changed" })
    expect(received).toMatchObject({
      event_severity: "alert",
      event_outcome: "success",
      actor_user_uuid: null,
    })
  })
})

describe("emitFromContext", () => {
  it("populates actor_user_uuid, actor_ip and actor_user_agent from the request", async () => {
    let received: unknown
    listeners.push({
      name: "capture",
      kind: "sync",
      handle: async (_db, event) => {
        received = event
      },
    })

    const ctx = fakeCtx()
    await emitFromContext(ctx, { event_type: "account.login.success" })

    expect(received).toMatchObject({
      actor_user_uuid: "actor-uuid",
      actor_ip: "203.0.113.7",
      actor_user_agent: "fake/1",
    })
  })

  it("honours an explicit null actor (e.g. failed login lookup)", async () => {
    let received: unknown
    listeners.push({
      name: "capture",
      kind: "sync",
      handle: async (_db, event) => {
        received = event
      },
    })

    const ctx = fakeCtx()
    await emitFromContext(ctx, {
      event_type: "account.login.failed",
      event_outcome: "failure",
      actor_user_uuid: null,
    })

    expect(received).toMatchObject({
      actor_user_uuid: null,
      event_outcome: "failure",
    })
  })

  it("skips dispatch and logs when dbClient is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const handle = vi.fn()
    listeners.push({ name: "audit", kind: "sync", handle })

    const ctx = fakeCtx({ data: {} })
    await emitFromContext(ctx, { event_type: "account.login.success" })

    expect(handle).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
