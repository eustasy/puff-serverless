import { describe, it, expect } from "vitest"
import { auditListener } from "../../src/hooks/listeners/audit.js"
import type { HookEvent } from "../../src/hooks/types.js"
import { FakeDb, pgError } from "../helpers/fake-db.js"

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    event_type: "account.login.success",
    event_severity: "info",
    event_outcome: "success",
    actor_user_uuid: "user-1",
    actor_ip: "203.0.113.1",
    actor_user_agent: "Mozilla/5.0",
    target_user_uuid: null,
    target_org_uuid: null,
    target_team_uuid: null,
    target_app_uuid: null,
    target_label: null,
    event_metadata: null,
    ...overrides,
  }
}

describe("auditListener", () => {
  it("inserts a row with positional column values", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO audit_events/, { rowCount: 1 })

    await auditListener.handle(db.client, makeEvent())

    expect(db.calls).toHaveLength(1)
    const values = db.calls[0].values
    // event_uuid is generated; the remaining 12 positional values follow the
    // column order in src/hooks/listeners/audit.ts.
    expect(values).toHaveLength(13)
    expect(typeof values[0]).toBe("string")
    expect(values[1]).toBe("account.login.success")
    expect(values[2]).toBe("info")
    expect(values[3]).toBe("success")
    expect(values[4]).toBe("user-1")
    expect(values[5]).toBe("203.0.113.1")
    expect(values[6]).toBe("Mozilla/5.0")
  })

  it("JSON-encodes event_metadata when provided", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO audit_events/, { rowCount: 1 })

    await auditListener.handle(
      db.client,
      makeEvent({ event_metadata: { reason: "bad_password", attempts: 3 } })
    )

    expect(db.calls[0].values[12]).toBe(
      '{"reason":"bad_password","attempts":3}'
    )
  })

  it("passes null metadata through unchanged", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO audit_events/, { rowCount: 1 })

    await auditListener.handle(db.client, makeEvent({ event_metadata: null }))

    expect(db.calls[0].values[12]).toBeNull()
  })

  it("rethrows when the insert fails so the dispatcher can surface it", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO audit_events/, pgError("08006"))

    await expect(auditListener.handle(db.client, makeEvent())).rejects.toThrow()
  })

  it("declares itself as a sync listener", () => {
    expect(auditListener.name).toBe("audit")
    expect(auditListener.kind).toBe("sync")
  })
})
