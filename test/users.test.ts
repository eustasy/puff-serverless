import { describe, it, expect } from "vitest"
import { readUser, registerUser, loginUser, disableUser, enableUser, deleteUser, updateLastLogin, getUserByEmail } from "../src/users.js"
import { puff_hashing_password } from "../src/utilities/hashing.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"
import { fakeEnv } from "./helpers/fake-env.js"

const READ_EMAIL = /FROM emails WHERE email_address = \$1 LIMIT 1/
const LONG_PASSWORD = "correct horse battery staple"

// Builds the stored `hash:salt` secret value for a known password.
async function storedPassword(pw: string): Promise<string> {
  const { hash, salt } = await puff_hashing_password(pw, "login-salt", "SHA-384")
  return `${hash}:${salt}`
}

describe("readUser", () => {
  it("returns the user when active", async () => {
    const db = new FakeDb()
    const user = { user_uuid: "user-1", user_name: "alice" }
    db.on(/FROM users WHERE user_uuid/, { rows: [user] })
    expect(await readUser(db.client, "user-1")).toMatchObject({
      success: true,
      user,
      status: 200,
    })
  })

  it("returns 404 when there is no active user", async () => {
    const db = new FakeDb()
    db.on(/FROM users WHERE user_uuid/, { rows: [] })
    expect((await readUser(db.client, "user-1")).status).toBe(404)
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/FROM users WHERE user_uuid/, pgError("08006"))
    expect((await readUser(db.client, "user-1")).status).toBe(500)
  })
})

describe("registerUser", () => {
  it("creates the user, primary email and password", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [] }) // existsEmail
    db.on(/INSERT INTO users/, { rowCount: 1 })
    db.on(READ_EMAIL, { rows: [] }) // createEmail's own lookup
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    db.on(/INSERT INTO tokens/, { rows: [{ token_value: "tok" }] })
    db.on(/INSERT INTO secrets/, { rows: [{ user_uuid: "x" }] })

    const result = await registerUser(db.client, fakeEnv(), "alice", "a@b.test", LONG_PASSWORD)
    expect(result).toMatchObject({ success: true, email: "a@b.test" })
    expect(result.user_uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("throws when the email is already registered", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [{ "?column?": 1 }] })
    await expect(registerUser(db.client, fakeEnv(), "alice", "a@b.test", LONG_PASSWORD)).rejects.toThrow("already registered")
  })

  it("throws when the email-existence check itself fails", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, pgError("08006")) // existsEmail → error envelope
    await expect(registerUser(db.client, fakeEnv(), "alice", "a@b.test", LONG_PASSWORD)).rejects.toThrow("verify email existence")
  })

  it("throws when adding the primary email fails", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [] })
    db.on(/INSERT INTO users/, { rowCount: 1 })
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    db.on(/INSERT INTO tokens/, pgError("08006")) // verification-token creation fails → createEmail error
    await expect(registerUser(db.client, fakeEnv(), "alice", "a@b.test", LONG_PASSWORD)).rejects.toThrow()
  })

  it("throws when creating the password fails", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [] })
    db.on(/INSERT INTO users/, { rowCount: 1 })
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    db.on(/INSERT INTO tokens/, { rows: [{ token_value: "tok" }] })
    db.on(/INSERT INTO secrets/, pgError("08006")) // createPassword → error envelope
    await expect(registerUser(db.client, fakeEnv(), "alice", "a@b.test", LONG_PASSWORD)).rejects.toThrow()
  })
})

describe("loginUser", () => {
  // Wires up a FakeDb for a login attempt with a known stored password.
  async function loginDb(opts: { userActive?: boolean; has2fa?: boolean }): Promise<FakeDb> {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [{ user_uuid: "user-1", email_address: "a@b.test" }],
    })
    db.on(/secret_value, secret_type/, {
      rows: [
        {
          secret_value: await storedPassword(LONG_PASSWORD),
          secret_type: "puff_password_SHA-384",
        },
      ],
    })
    db.on(/UPDATE secrets SET secret_last_used/, { rowCount: 1 })
    db.on(/SELECT user_active FROM users/, {
      rows: [{ user_active: opts.userActive ?? true }],
    })
    db.on(/SELECT 1\s+FROM secrets/, { rows: opts.has2fa ? [{}] : [] })
    db.on(/INSERT INTO sessions/, { rowCount: 1 })
    db.on(/UPDATE users SET user_last_login/, { rowCount: 1 })
    return db
  }

  it("grants a session for a correct password and no 2FA", async () => {
    const db = await loginDb({})
    const result = await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "1.2.3.4", "GB", 12)
    expect(result).toMatchObject({ success: true, status: 200 })
    if (!result.success) throw new Error("expected success")
    expect(result.session_id).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns the generic 401 for an unknown email", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    expect(await loginUser(db.client, "ghost@b.test", "pw", "ua", "ip", "GB", 12)).toMatchObject({ error: true, status: 401 })
  })

  it("returns the generic 401 for a wrong password", async () => {
    const db = await loginDb({})
    // isPasswordReused re-reads the password history after the active check.
    db.on(/secret_type, secret_value/, { rows: [] })
    const result = await loginUser(db.client, "a@b.test", "the wrong password", "ua", "ip", "GB", 12)
    expect(result).toMatchObject({ error: true, status: 401 })
  })

  it("rejects a disabled account with 403", async () => {
    const db = await loginDb({ userActive: false })
    expect(await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)).toMatchObject({ error: true, status: 403 })
  })

  it("routes to the 2FA step when the account has 2FA enabled", async () => {
    const db = await loginDb({ has2fa: true })
    const result = await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)
    expect(result).toMatchObject({ success: true, totp_required: true })
  })

  it("requires a password upgrade when the password is below the minimum", async () => {
    const db = await loginDb({})
    const result = await loginUser(
      db.client,
      "a@b.test",
      LONG_PASSWORD,
      "ua",
      "ip",
      "GB",
      // Minimum raised above the stored password's length.
      LONG_PASSWORD.length + 1
    )
    expect(result).toMatchObject({
      success: true,
      password_upgrade_required: true,
    })
  })

  it("returns the generic 401 when reading the email errors", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, pgError("08006")) // readEmail → error envelope
    expect(await loginUser(db.client, "a@b.test", "pw", "ua", "ip", "GB", 12)).toMatchObject({ error: true, status: 401 })
  })

  it("returns an error when password verification fails internally", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(/secret_value, secret_type/, pgError("08006")) // readPassword → error → verifyPassword error
    expect(await loginUser(db.client, "a@b.test", "pw", "ua", "ip", "GB", 12)).toMatchObject({ error: true })
  })

  it("tells the user when they entered a previously-used password", async () => {
    const db = await loginDb({})
    const { hash, salt } = await puff_hashing_password("an old password", "s1", "SHA-384")
    // Active check fails (wrong pw); the history lookup then matches a past one.
    db.on(/secret_type, secret_value/, { rows: [{ secret_type: "puff_password_SHA-384", secret_value: `${hash}:${salt}` }] })
    const r = await loginUser(db.client, "a@b.test", "an old password", "ua", "ip", "GB", 12)
    expect(r).toMatchObject({ error: true, status: 401, message: expect.stringContaining("previously used") })
  })

  it("logs but still succeeds when the hash upgrade-on-login fails", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    // Stored under an outdated algorithm so needs_upgrade is true.
    const { hash, salt } = await puff_hashing_password(LONG_PASSWORD, "login-salt", "SHA-256")
    db.on(/secret_value, secret_type/, { rows: [{ secret_value: `${hash}:${salt}`, secret_type: "puff_password_SHA-256" }] })
    db.on(/UPDATE secrets SET secret_last_used/, { rowCount: 1 })
    db.on(/SET is_enabled = FALSE/, pgError("08006")) // updatePassword fails (best-effort, logged)
    db.on(/SELECT user_active FROM users/, { rows: [{ user_active: true }] })
    db.on(/SELECT 1\s+FROM secrets/, { rows: [] }) // no 2FA
    db.on(/INSERT INTO sessions/, { rowCount: 1 })
    db.on(/UPDATE users SET user_last_login/, { rowCount: 1 })
    const r = await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)
    expect(r).toMatchObject({ success: true, status: 200 })
  })

  it("returns an error when the 2FA check fails", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(/secret_value, secret_type/, {
      rows: [{ secret_value: await storedPassword(LONG_PASSWORD), secret_type: "puff_password_SHA-384" }],
    })
    db.on(/UPDATE secrets SET secret_last_used/, { rowCount: 1 })
    db.on(/SELECT user_active FROM users/, { rows: [{ user_active: true }] })
    db.on(/SELECT 1\s+FROM secrets/, pgError("08006")) // has2fa → error
    expect(await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)).toMatchObject({ error: true })
  })

  it("returns an error when session creation fails", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(/secret_value, secret_type/, {
      rows: [{ secret_value: await storedPassword(LONG_PASSWORD), secret_type: "puff_password_SHA-384" }],
    })
    db.on(/UPDATE secrets SET secret_last_used/, { rowCount: 1 })
    db.on(/SELECT user_active FROM users/, { rows: [{ user_active: true }] })
    db.on(/SELECT 1\s+FROM secrets/, { rows: [] }) // no 2FA
    db.on(/INSERT INTO sessions/, pgError("08006")) // createSession → error envelope
    expect(await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)).toMatchObject({ error: true })
  })

  it("returns 500 on an unexpected error during login", async () => {
    const db = new FakeDb()
    // readEmail is awaited outside an inner guard; a thrown non-envelope error
    // from the active-user SELECT lands in loginUser's own catch.
    db.on(READ_EMAIL, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(/secret_value, secret_type/, {
      rows: [{ secret_value: await storedPassword(LONG_PASSWORD), secret_type: "puff_password_SHA-384" }],
    })
    db.on(/UPDATE secrets SET secret_last_used/, { rowCount: 1 })
    db.on(/SELECT user_active FROM users/, pgError("08006"))
    expect((await loginUser(db.client, "a@b.test", LONG_PASSWORD, "ua", "ip", "GB", 12)).status).toBe(500)
  })
})

describe("disableUser", () => {
  it("marks the account inactive and terminates its sessions", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = FALSE/, {
      rows: [{ user_uuid: "user-1" }],
    })
    db.on(/UPDATE sessions SET is_active = FALSE/, { rowCount: 4 })
    expect(await disableUser(db.client, "user-1")).toEqual({
      success: true,
      terminated_sessions: 4,
      status: 200,
    })
  })

  it("returns 404 when the user does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = FALSE/, { rows: [] })
    const result = await disableUser(db.client, "user-1")
    expect(result).toMatchObject({ success: false, status: 404 })
    expect(db.calls.map((c) => c.text)).toContain("ROLLBACK")
  })

  it("rolls back when terminating the user's sessions fails", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = FALSE/, { rows: [{ user_uuid: "user-1" }] })
    db.on(/UPDATE sessions SET is_active = FALSE/, pgError("08006")) // terminateAllSessions → error envelope
    const result = await disableUser(db.client, "user-1")
    expect(result).toMatchObject({ error: true })
    expect(db.calls.map((c) => c.text)).toContain("ROLLBACK")
  })

  it("returns 500 when the transaction cannot begin", async () => {
    const db = new FakeDb()
    db.on(/BEGIN/, pgError("08006"))
    expect((await disableUser(db.client, "user-1")).status).toBe(500)
  })
})

describe("enableUser", () => {
  it("reactivates an account", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = TRUE/, { rowCount: 1 })
    expect(await enableUser(db.client, "user-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the user does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = TRUE/, { rowCount: 0 })
    expect((await enableUser(db.client, "user-1")).status).toBe(404)
  })

  it("returns 500 when the update throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_active = TRUE/, pgError("08006"))
    expect((await enableUser(db.client, "user-1")).status).toBe(500)
  })
})

describe("deleteUser", () => {
  it("succeeds when the user solely owns no organisation", async () => {
    const db = new FakeDb()
    db.on(/HAVING count/, { rows: [] }) // sole-owner pre-check: none
    db.on(/DELETE FROM users/, { rows: [{ user_uuid: "user-1" }] })
    expect(await deleteUser(db.client, "user-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the user does not exist", async () => {
    const db = new FakeDb()
    db.on(/HAVING count/, { rows: [] })
    db.on(/DELETE FROM users/, { rows: [] })
    expect((await deleteUser(db.client, "user-1")).status).toBe(404)
  })

  it("refuses with 409 when the user is an organisation's sole owner", async () => {
    const db = new FakeDb()
    db.on(/HAVING count/, { rows: [{ org_name: "Acme" }] })
    const result = await deleteUser(db.client, "user-1")
    expect(result).toMatchObject({ success: false, status: 409 })
    // The user row is left untouched.
    expect(db.calls.some((c) => c.text.includes("DELETE FROM users"))).toBe(false)
  })

  it("returns 500 when the transaction cannot begin", async () => {
    const db = new FakeDb()
    db.on(/BEGIN/, pgError("08006"))
    expect((await deleteUser(db.client, "user-1")).status).toBe(500)
  })
})

describe("updateLastLogin", () => {
  it("returns 200 when a row was updated", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_last_login/, { rowCount: 1 })
    expect(await updateLastLogin(db.client, "user-1")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("returns 404 when the user does not exist", async () => {
    const db = new FakeDb()
    db.on(/UPDATE users SET user_last_login/, { rowCount: 0 })
    expect((await updateLastLogin(db.client, "user-1")).status).toBe(404)
  })
})

describe("getUserByEmail", () => {
  it("resolves an active user from one of their email addresses", async () => {
    const db = new FakeDb()
    db.on(/JOIN emails e/, {
      rows: [{ user_uuid: "user-1", user_name: "Jane Smith" }],
    })
    expect(await getUserByEmail(db.client, "jane@example.com")).toEqual({
      success: true,
      user_uuid: "user-1",
      user_name: "Jane Smith",
      status: 200,
    })
  })

  it("returns 404 when no active user owns the address", async () => {
    const db = new FakeDb()
    db.on(/JOIN emails e/, { rows: [] })
    expect((await getUserByEmail(db.client, "ghost@example.com")).status).toBe(404)
  })

  it("returns 500 when the query throws", async () => {
    const db = new FakeDb()
    db.on(/JOIN emails e/, pgError("08006"))
    expect((await getUserByEmail(db.client, "jane@example.com")).status).toBe(500)
  })
})
