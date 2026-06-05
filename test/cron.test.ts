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

// The scheduled handler delegates the real work to other `src/` modules; those
// are mocked so the dispatch/logging branches in cron.ts can be driven in
// isolation (success vs failure vs throw) without exercising billing/usage SQL.
const deps = vi.hoisted(() => ({
  maybeRotateSigningKey: vi.fn(),
  recomputeUsageRollups: vi.fn(),
  syncUsageRollups: vi.fn(),
  createStripeProvider: vi.fn(),
  reconcileBillingEmails: vi.fn(),
}))

vi.mock("../src/oauth-keys-rotation.js", () => ({ maybeRotateSigningKey: deps.maybeRotateSigningKey }))
vi.mock("../src/usage.js", () => ({
  recomputeUsageRollups: deps.recomputeUsageRollups,
  syncUsageRollups: deps.syncUsageRollups,
}))
vi.mock("../src/billing-stripe.js", () => ({ createStripeProvider: deps.createStripeProvider }))
vi.mock("../src/billing.js", () => ({ reconcileBillingEmails: deps.reconcileBillingEmails }))

const { runScheduledCleanup, scheduled } = await import("../src/cron.js")

const HOURLY_CRON = "0 * * * *"
const DAILY_CRON = "0 0 * * *"

const HYPERDRIVE = fakeEnv({
  HYPERDRIVE: { connectionString: "postgres://localhost/test" },
} as Partial<Env>)

const HYPERDRIVE_BILLING = fakeEnv({
  HYPERDRIVE: { connectionString: "postgres://localhost/test" },
  STRIPE_SECRET_KEY: "sk_test_123",
} as Partial<Env>)

// Invoke the Worker `scheduled` handler and await whatever it hands to
// `waitUntil`, so the async work it kicks off has finished before assertions.
async function runScheduled(env: Env, cron: string): Promise<void> {
  const tasks: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
  } as unknown as ExecutionContext
  await scheduled({ cron } as ScheduledController, env, ctx)
  await Promise.all(tasks)
}

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rowCount: 0 })
  connectMock.mockReset().mockResolvedValue(undefined)
  endMock.mockReset().mockResolvedValue(undefined)
  deps.maybeRotateSigningKey.mockReset().mockResolvedValue(undefined)
  deps.recomputeUsageRollups.mockReset().mockResolvedValue({ success: true, upserted: 0 })
  deps.syncUsageRollups.mockReset().mockResolvedValue({ success: true, synced: 0 })
  deps.createStripeProvider.mockReset().mockReturnValue({ name: "stripe" })
  deps.reconcileBillingEmails.mockReset().mockResolvedValue({ success: true, reconciled: 0 })
  // cron work logs progress/errors; keep test output quiet.
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("scheduled dispatch", () => {
  it("routes the hourly cron to billing-email reconcile only", async () => {
    await runScheduled(HYPERDRIVE_BILLING, HOURLY_CRON)
    expect(deps.reconcileBillingEmails).toHaveBeenCalledTimes(1)
    expect(deps.maybeRotateSigningKey).not.toHaveBeenCalled()
    expect(deps.recomputeUsageRollups).not.toHaveBeenCalled()
  })

  it("routes the daily cron to key rotation and usage rollup, not billing reconcile", async () => {
    await runScheduled(HYPERDRIVE, DAILY_CRON)
    expect(deps.maybeRotateSigningKey).toHaveBeenCalledTimes(1)
    expect(deps.recomputeUsageRollups).toHaveBeenCalledTimes(2) // yesterday + today
    expect(deps.reconcileBillingEmails).not.toHaveBeenCalled()
  })

  it("swallows a key-rotation failure and still runs the usage rollup", async () => {
    deps.maybeRotateSigningKey.mockRejectedValue(new Error("rotation boom"))
    await runScheduled(HYPERDRIVE, DAILY_CRON)
    expect(deps.recomputeUsageRollups).toHaveBeenCalledTimes(2)
  })
})

describe("runBillingEmailReconcile (hourly path)", () => {
  it("skips when billing is not configured", async () => {
    await runScheduled(HYPERDRIVE, HOURLY_CRON) // no STRIPE_SECRET_KEY
    expect(connectMock).not.toHaveBeenCalled()
    expect(deps.reconcileBillingEmails).not.toHaveBeenCalled()
  })

  it("skips and logs when Hyperdrive is missing", async () => {
    const errSpy = vi.spyOn(console, "error")
    await runScheduled(fakeEnv({ STRIPE_SECRET_KEY: "sk_test_123" } as Partial<Env>), HOURLY_CRON)
    expect(connectMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HYPERDRIVE binding missing"))
  })

  it("logs the reconciled count on success and closes the client", async () => {
    deps.reconcileBillingEmails.mockResolvedValue({ success: true, reconciled: 4 })
    const logSpy = vi.spyOn(console, "log")
    await runScheduled(HYPERDRIVE_BILLING, HOURLY_CRON)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("updated 4 customers"))
    expect(endMock).toHaveBeenCalled()
  })

  it("logs the failure message when reconcile returns an error envelope", async () => {
    deps.reconcileBillingEmails.mockResolvedValue({ success: false, message: "nope" })
    const errSpy = vi.spyOn(console, "error")
    await runScheduled(HYPERDRIVE_BILLING, HOURLY_CRON)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("reconcile failed"), "nope")
    expect(endMock).toHaveBeenCalled()
  })

  it("never throws when reconcile throws, and still closes the client", async () => {
    deps.reconcileBillingEmails.mockRejectedValue(new Error("kaboom"))
    await expect(runScheduled(HYPERDRIVE_BILLING, HOURLY_CRON)).resolves.toBeUndefined()
    expect(endMock).toHaveBeenCalled()
  })

  it("swallows an error thrown while closing the client", async () => {
    endMock.mockRejectedValue(new Error("close failed"))
    await expect(runScheduled(HYPERDRIVE_BILLING, HOURLY_CRON)).resolves.toBeUndefined()
  })
})

describe("runDailyUsageRollup (daily path)", () => {
  it("skips and logs when Hyperdrive is missing", async () => {
    const errSpy = vi.spyOn(console, "error")
    await runScheduled(fakeEnv(), DAILY_CRON) // no HYPERDRIVE
    expect(connectMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HYPERDRIVE binding missing"))
  })

  it("recomputes both the previous and current UTC day on success", async () => {
    const logSpy = vi.spyOn(console, "log")
    await runScheduled(HYPERDRIVE, DAILY_CRON)
    expect(deps.recomputeUsageRollups).toHaveBeenCalledTimes(2)
    const days = deps.recomputeUsageRollups.mock.calls.map((c) => c[1] as string)
    expect(days[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // yesterday
    expect(days[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // today
    expect(days[0] < days[1]).toBe(true)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("upserted"))
  })

  it("logs each rollup failure but keeps going", async () => {
    deps.recomputeUsageRollups
      .mockResolvedValueOnce({ success: false, message: "y-fail" })
      .mockResolvedValueOnce({ success: false, message: "t-fail" })
    const errSpy = vi.spyOn(console, "error")
    await runScheduled(HYPERDRIVE, DAILY_CRON)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed for"), "y-fail")
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed for"), "t-fail")
  })

  it("does not sync to the provider when billing is not configured", async () => {
    await runScheduled(HYPERDRIVE, DAILY_CRON)
    expect(deps.syncUsageRollups).not.toHaveBeenCalled()
  })

  it("syncs rollups to the provider and logs the count when billing is configured", async () => {
    deps.syncUsageRollups.mockResolvedValue({ success: true, synced: 7 })
    const logSpy = vi.spyOn(console, "log")
    await runScheduled(HYPERDRIVE_BILLING, DAILY_CRON)
    expect(deps.syncUsageRollups).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("synced 7 rollups"))
  })

  it("logs a provider sync failure envelope", async () => {
    deps.syncUsageRollups.mockResolvedValue({ success: false, message: "sync-bad" })
    const errSpy = vi.spyOn(console, "error")
    await runScheduled(HYPERDRIVE_BILLING, DAILY_CRON)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("provider sync failed"), "sync-bad")
  })

  it("swallows a thrown provider sync error", async () => {
    deps.syncUsageRollups.mockRejectedValue(new Error("sync-throw"))
    await expect(runScheduled(HYPERDRIVE_BILLING, DAILY_CRON)).resolves.toBeUndefined()
    expect(endMock).toHaveBeenCalled()
  })

  it("never throws when connect fails, and reports the error", async () => {
    connectMock.mockRejectedValue(new Error("connect down"))
    const errSpy = vi.spyOn(console, "error")
    await expect(runScheduled(HYPERDRIVE, DAILY_CRON)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected error"), expect.any(Error))
  })

  it("swallows an error thrown while closing the client", async () => {
    endMock.mockRejectedValue(new Error("close failed"))
    await expect(runScheduled(HYPERDRIVE, DAILY_CRON)).resolves.toBeUndefined()
  })
})

// `runScheduledCleanup` is kept as a manually-callable fallback after the
// pure-SQL cleanup work moved to CockroachDB-side schedules
// (`sql/schedules.sql`). It now always runs every purge in one pass; the
// scheduled cron handler dispatches to the rotation path instead.
describe("runScheduledCleanup", () => {
  it("skips entirely when no Hyperdrive binding is configured", async () => {
    await runScheduledCleanup(fakeEnv())
    expect(connectMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it("runs all five purges in one pass", async () => {
    await runScheduledCleanup(HYPERDRIVE)
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
    await runScheduledCleanup(HYPERDRIVE)
    expect(endMock).toHaveBeenCalled()
  })

  it("never throws, even when a query fails", async () => {
    queryMock.mockRejectedValue(new Error("db down"))
    await expect(runScheduledCleanup(HYPERDRIVE)).resolves.toBeUndefined()
    // The client is still closed on the failure path.
    expect(endMock).toHaveBeenCalled()
  })

  it("swallows an error thrown while closing the client", async () => {
    endMock.mockRejectedValue(new Error("close failed"))
    await expect(runScheduledCleanup(HYPERDRIVE)).resolves.toBeUndefined()
  })

  it("treats a null rowCount as zero in the summary", async () => {
    queryMock.mockResolvedValue({ rowCount: null })
    const logSpy = vi.spyOn(console, "log")
    await runScheduledCleanup(HYPERDRIVE)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("purged 0 TOTP codes"))
  })
})
