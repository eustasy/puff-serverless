import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  verifyTokenAndGetUser,
  verifySessionToken,
  createSession,
  terminateSession,
  terminateAllOtherSessions,
  terminateAllSessions,
  readSessions,
} from "../src/sessions.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"
import { fakeEnv } from "./helpers/fake-env.js"

// verifySessionToken opens its own short-lived pg Client; mock it so that one
// function can be exercised without a real database (precedent:
// oauth-keys-rotation.test.ts). The FakeDb-based tests below don't construct a
// Client, so the mock is inert for them.
const { connectMock, endMock, clientQueryMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  endMock: vi.fn(),
  clientQueryMock: vi.fn(),
}))
vi.mock("pg", () => ({
  Client: class {
    connect = connectMock
    end = endMock
    query = clientQueryMock
  },
}))

const future = () => new Date(Date.now() + 60_000)
const past = () => new Date(Date.now() - 60_000)

describe("verifyTokenAndGetUser", () => {
  // The function also fires a background last-accessed UPDATE; scripting it
  // keeps that fire-and-forget query from logging an unhandled rejection.
  const withSession = (row: Record<string, unknown> | undefined) => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM sessions/, { rows: row ? [row] : [] })
    db.on(/UPDATE sessions SET last_accessed_at/, { rowCount: 1 })
    return db
  }

  it("returns the user for a valid, active, unexpired session", async () => {
    const db = withSession({
      user_uuid: "user-1",
      expires_at: future(),
      ip_country: "GB",
    })
    expect(await verifyTokenAndGetUser(db.client, "tok", "GB", "1.2.3.4")).toEqual({ success: true, user_uuid: "user-1", status: 200 })
  })

  it("rejects an unknown session token with 401", async () => {
    const db = withSession(undefined)
    expect(await verifyTokenAndGetUser(db.client, "tok", null, null)).toEqual({
      error: "Invalid session token.",
      status: 401,
    })
  })

  it("rejects an expired session with 401", async () => {
    const db = withSession({
      user_uuid: "user-1",
      expires_at: past(),
      ip_country: "GB",
    })
    expect(await verifyTokenAndGetUser(db.client, "tok", "GB", null)).toEqual({
      error: "Session token expired.",
      status: 401,
    })
  })

  it("rejects a session whose country no longer matches with 401", async () => {
    const db = withSession({
      user_uuid: "user-1",
      expires_at: future(),
      ip_country: "GB",
    })
    const result = await verifyTokenAndGetUser(db.client, "tok", "FR", null)
    expect(result.status).toBe(401)
    expect(result).toHaveProperty("error")
  })

  it("allows the request when the stored country is null", async () => {
    const db = withSession({
      user_uuid: "user-1",
      expires_at: future(),
      ip_country: null,
    })
    const result = await verifyTokenAndGetUser(db.client, "tok", "FR", null)
    expect(result.success).toBe(true)
  })

  it("returns 500 when the lookup query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM sessions/, pgError("08006"))
    expect(await verifyTokenAndGetUser(db.client, "tok", null, null)).toEqual({
      error: "Error during token verification.",
      status: 500,
    })
  })

  it("succeeds even if the background last-accessed update rejects", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM sessions/, {
      rows: [{ user_uuid: "user-1", expires_at: future(), ip_country: "GB" }],
    })
    db.on(/UPDATE sessions SET last_accessed_at/, pgError("08006"))
    const result = await verifyTokenAndGetUser(db.client, "tok", "GB", "1.2.3.4")
    expect(result.success).toBe(true)
    // Let the fire-and-forget rejection handler run before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe("verifySessionToken", () => {
  beforeEach(() => {
    connectMock.mockReset().mockResolvedValue(undefined)
    endMock.mockReset().mockResolvedValue(undefined)
    clientQueryMock.mockReset()
  })

  it("returns false when no Hyperdrive binding is configured", async () => {
    expect(await verifySessionToken(fakeEnv(), "tok", null, null)).toBe(false)
  })

  it("returns false when the connection string is empty", async () => {
    const env = fakeEnv({ HYPERDRIVE: { connectionString: "" } as Env["HYPERDRIVE"] })
    expect(await verifySessionToken(env, "tok", null, null)).toBe(false)
  })

  it("returns true for a valid session over its own connection", async () => {
    clientQueryMock.mockResolvedValue({
      rows: [{ user_uuid: "user-1", expires_at: future(), ip_country: "GB" }],
      rowCount: 1,
    })
    const env = fakeEnv({ HYPERDRIVE: { connectionString: "postgres://localhost/test" } as Env["HYPERDRIVE"] })
    expect(await verifySessionToken(env, "tok", "GB", "1.2.3.4")).toBe(true)
    expect(endMock).toHaveBeenCalled()
  })

  it("returns false when the session is invalid", async () => {
    clientQueryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    const env = fakeEnv({ HYPERDRIVE: { connectionString: "postgres://localhost/test" } as Env["HYPERDRIVE"] })
    expect(await verifySessionToken(env, "tok", null, null)).toBe(false)
  })

  it("fails closed (false) when connecting throws, still closing the client", async () => {
    connectMock.mockRejectedValue(new Error("connection refused"))
    const env = fakeEnv({ HYPERDRIVE: { connectionString: "postgres://localhost/test" } as Env["HYPERDRIVE"] })
    expect(await verifySessionToken(env, "tok", null, null)).toBe(false)
    expect(endMock).toHaveBeenCalled()
  })
})

describe("createSession", () => {
  const ready = () => {
    const db = new FakeDb()
    db.on(/INSERT INTO sessions/, { rowCount: 1 })
    db.on(/UPDATE users SET user_last_login/, { rowCount: 1 })
    return db
  }

  it("rejects a missing user UUID with 400", async () => {
    const db = ready()
    expect(await createSession(db.client, "", "ua", "ip", "GB")).toEqual({
      error: "User UUID is required.",
      status: 400,
    })
  })

  it("creates a 64-hex-char session lasting ~7 days and records the login", async () => {
    const db = ready()
    const result = await createSession(db.client, "user-1", "ua", "1.2.3.4", "GB")
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(result.session_id).toMatch(/^[0-9a-f]{64}$/)
    const days = (result.expires_at.getTime() - Date.now()) / (24 * 3_600_000)
    expect(days).toBeCloseTo(7, 1)
    // INSERT then the updateLastLogin UPDATE.
    expect(db.calls.map((c) => c.text.split(" ").slice(0, 2).join(" "))).toEqual(["INSERT INTO", "UPDATE users"])
  })

  it("includes only the optional columns that were supplied", async () => {
    const db = ready()
    await createSession(db.client, "user-1", "", "", "")
    // user_uuid, session_id, expires_at — no user_agent/ip_address/ip_country.
    expect(db.calls[0].values).toHaveLength(3)
    expect(db.calls[0].text).not.toContain("user_agent")
  })

  it("fails with 500 when recording the login throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO sessions/, { rowCount: 1 })
    db.on(/UPDATE users SET user_last_login/, pgError("08006"))
    expect(await createSession(db.client, "user-1", "ua", "ip", "GB")).toEqual({
      error: "Failed to start session due to a server error.",
      status: 500,
    })
  })
})

describe("terminateSession", () => {
  it("succeeds when the session existed and was owned by the user", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions SET is_active = FALSE/, { rowCount: 1 })
    expect(await terminateSession(db.client, "user-1", "sess-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when no matching active session was found", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions SET is_active = FALSE/, { rowCount: 0 })
    expect(await terminateSession(db.client, "user-1", "sess-1")).toEqual({
      error: "Session not found or already terminated.",
      status: 404,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions/, pgError("08006"))
    expect((await terminateSession(db.client, "u", "s")).status).toBe(500)
  })
})

describe("terminateAllOtherSessions", () => {
  it("reports how many sessions were ended", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions SET is_active = FALSE/, { rowCount: 3 })
    expect(await terminateAllOtherSessions(db.client, "user-1", "keep-me")).toEqual({ success: true, deletedCount: 3, status: 200 })
    expect(db.calls[0].values).toEqual(["user-1", "keep-me"])
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions/, pgError("08006"))
    expect((await terminateAllOtherSessions(db.client, "user-1", "keep-me")).status).toBe(500)
  })
})

describe("terminateAllSessions", () => {
  it("reports how many sessions were ended", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions SET is_active = FALSE/, { rowCount: 2 })
    expect(await terminateAllSessions(db.client, "user-1")).toEqual({
      success: true,
      deletedCount: 2,
      status: 200,
    })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE sessions/, pgError("08006"))
    expect((await terminateAllSessions(db.client, "user-1")).status).toBe(500)
  })
})

describe("readSessions", () => {
  it("returns the user's sessions newest-first as given by the query", async () => {
    const db = new FakeDb()
    const rows = [{ session_id: "a" }, { session_id: "b" }]
    db.on(/SELECT .* FROM sessions/, { rows })
    const result = await readSessions(db.client, "user-1")
    expect(result).toEqual({ success: true, sessions: rows, status: 200 })
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT .* FROM sessions/, pgError("08006"))
    expect((await readSessions(db.client, "user-1")).status).toBe(500)
  })
})
