import { describe, it, expect, vi, beforeEach } from "vitest"
import { fakeEnv } from "./helpers/fake-env.js"

// cron.ts opens its own `pg` client (it runs with no middleware in front of
// it), so the client is mocked at the module level rather than injected.
const { queryMock, connectMock, endMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  endMock: vi.fn(),
}))

vi.mock("pg", () => ({
  Client: class {
    connect = connectMock
    end = endMock
    query = queryMock
  },
}))

const { runScheduledCleanup } = await import("../src/cron.js")

const HYPERDRIVE = fakeEnv({
  HYPERDRIVE: { connectionString: "postgres://localhost/test" },
} as Partial<Env>)

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rowCount: 0 })
  connectMock.mockReset().mockResolvedValue(undefined)
  endMock.mockReset().mockResolvedValue(undefined)
})

describe("runScheduledCleanup", () => {
  it("skips entirely when no Hyperdrive binding is configured", async () => {
    await runScheduledCleanup(fakeEnv(), "0 * * * *")
    expect(connectMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it("purges TOTP codes and floating sessions on every run", async () => {
    await runScheduledCleanup(HYPERDRIVE, "*/5 * * * *")
    expect(queryMock).toHaveBeenCalledTimes(2)
    const statements = queryMock.mock.calls.map((c) => c[0] as string)
    expect(statements[0]).toContain("totp_used_codes")
    expect(statements[1]).toContain("app_floating_sessions")
  })

  it("also purges sessions, tokens and low-severity audit events on the hourly run", async () => {
    await runScheduledCleanup(HYPERDRIVE, "0 * * * *")
    expect(queryMock).toHaveBeenCalledTimes(5)
    const statements = queryMock.mock.calls.map((c) => c[0] as string)
    expect(statements[0]).toContain("totp_used_codes")
    expect(statements[1]).toContain("app_floating_sessions")
    expect(statements[2]).toContain("sessions")
    expect(statements[3]).toContain("tokens")
    expect(statements[4]).toContain("audit_events")
    expect(statements[4]).toMatch(/event_severity IN \('debug', 'info'\)/)
  })

  it("always closes the client", async () => {
    await runScheduledCleanup(HYPERDRIVE, "0 * * * *")
    expect(endMock).toHaveBeenCalled()
  })

  it("never throws, even when a query fails", async () => {
    queryMock.mockRejectedValue(new Error("db down"))
    await expect(
      runScheduledCleanup(HYPERDRIVE, "0 * * * *")
    ).resolves.toBeUndefined()
    // The client is still closed on the failure path.
    expect(endMock).toHaveBeenCalled()
  })
})
