import { describe, it, expect } from "vitest"
import { existsEmail, readEmail, readEmails, createEmail, verifyEmailByToken, setPrimaryEmail, deleteEmail } from "../src/emails.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

// readEmail's single-record lookup, distinct from existsEmail's `SELECT 1`.
const READ_EMAIL = /FROM emails WHERE email_address = \$1 LIMIT 1/

const emailRow = (over: Partial<EmailRow> = {}): EmailRow => ({
  user_uuid: "user-1",
  email_address: "a@b.test",
  is_primary: false,
  is_verified: true,
  verified_at: new Date(),
  ...over,
})

describe("existsEmail", () => {
  it("reports whether the address exists", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [{ "?column?": 1 }] })
    expect(await existsEmail(db.client, "a@b.test")).toEqual({
      success: true,
      exists: true,
    })
  })

  it("reports exists: false for an unknown address", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, { rows: [] })
    expect(await existsEmail(db.client, "a@b.test")).toMatchObject({
      exists: false,
    })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT 1 FROM emails/, pgError("08006"))
    expect(await existsEmail(db.client, "a@b.test")).toMatchObject({ error: true })
  })
})

describe("readEmail", () => {
  it("returns the email record when found", async () => {
    const db = new FakeDb()
    const row = emailRow()
    db.on(READ_EMAIL, { rows: [row] })
    expect(await readEmail(db.client, "a@b.test")).toEqual({
      success: true,
      email: row,
    })
  })

  it("returns success: false when not found", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    expect(await readEmail(db.client, "a@b.test")).toMatchObject({
      success: false,
      message: "Email not found.",
    })
  })

  it("returns an error envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, pgError("08006"))
    expect(await readEmail(db.client, "a@b.test")).toMatchObject({ error: true })
  })
})

describe("readEmails", () => {
  it("returns every address for the user", async () => {
    const db = new FakeDb()
    const rows = [emailRow(), emailRow({ email_address: "c@d.test" })]
    db.on(/FROM emails WHERE user_uuid/, { rows })
    expect(await readEmails(db.client, "user-1")).toEqual(rows)
  })

  it("re-throws on a database error", async () => {
    const db = new FakeDb()
    db.on(/FROM emails WHERE user_uuid/, pgError("08006"))
    await expect(readEmails(db.client, "user-1")).rejects.toThrow()
  })
})

describe("createEmail", () => {
  it("rejects an address the same user already has with 409", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1" })] })
    expect(await createEmail(db.client, "user-1", "a@b.test")).toMatchObject({
      error: true,
      status: 409,
    })
  })

  it("returns a success shape with no token when the address belongs to another user", async () => {
    // Enumeration prevention: indistinguishable from a real add.
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else" })] })
    const result = await createEmail(db.client, "user-1", "a@b.test")
    expect(result).toMatchObject({ success: true, token_value: null })
  })

  it("inserts a new unverified address and issues a verification token", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    db.on(/INSERT INTO tokens/, { rows: [{ token_value: "tok" }] })
    const result = await createEmail(db.client, "user-1", "a@b.test")
    expect(result).toMatchObject({ success: true })
    if (!result.success) throw new Error("expected success")
    expect(result.token_value).not.toBeNull()
  })

  it("inserts a pre-verified address without a token", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    const result = await createEmail(db.client, "user-1", "a@b.test", true, true)
    expect(result).toMatchObject({ success: true, token_value: null })
  })

  it("treats an insert conflict as a successful add with no token (race)", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rowCount: 0, rows: [] }) // ON CONFLICT DO NOTHING
    const result = await createEmail(db.client, "user-1", "a@b.test")
    expect(result).toMatchObject({ success: true, token_value: null })
  })

  it("returns 500 when the verification token cannot be created", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, { rows: [{ email_address: "a@b.test" }] })
    db.on(/INSERT INTO tokens/, pgError("08006")) // createEmailToken → error envelope
    expect(await createEmail(db.client, "user-1", "a@b.test")).toMatchObject({ error: true, status: 500 })
  })

  it("re-throws when the insert itself fails", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    db.on(/INSERT INTO emails/, pgError("08006"))
    await expect(createEmail(db.client, "user-1", "a@b.test")).rejects.toThrow()
  })
})

describe("verifyEmailByToken", () => {
  it("verifies the email when the token is valid and unspent", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, {
      rows: [{ user_uuid: "user-1", email_address: "a@b.test" }],
    })
    db.on(READ_EMAIL, {
      rows: [emailRow({ is_verified: false })],
    })
    db.on(/UPDATE emails SET is_verified/, { rowCount: 1 })
    const result = await verifyEmailByToken(db.client, "tok")
    expect(result).toMatchObject({ success: true, user_uuid: "user-1" })
  })

  it("rejects an invalid or already-used token with 400", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [] })
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({
      error: true,
      status: 400,
    })
  })

  it("is idempotent for an already-verified email", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, {
      rows: [{ user_uuid: "user-1", email_address: "a@b.test" }],
    })
    db.on(READ_EMAIL, { rows: [emailRow({ is_verified: true })] })
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({
      success: true,
      message: "Email address already verified.",
    })
  })

  it("returns 500 when the consumed token has no associated email", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: null }] })
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 500 })
  })

  it("returns 404 when the verified token's email no longer exists", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(READ_EMAIL, { rows: [] }) // readEmail → success:false (not found)
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 404 })
  })

  it("returns 500 when reading the email errors", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(READ_EMAIL, pgError("08006")) // readEmail → error envelope
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 500 })
  })

  it("rejects when the token's user does not match the email's owner", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else", is_verified: false })] })
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 400 })
  })

  it("returns 500 when the verification update affects no rows", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_verified: false })] })
    db.on(/UPDATE emails SET is_verified/, { rowCount: 0 })
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 500 })
  })

  it("returns 500 when the verification update throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE tokens SET is_used = TRUE/, { rows: [{ user_uuid: "user-1", email_address: "a@b.test" }] })
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_verified: false })] })
    db.on(/UPDATE emails SET is_verified/, pgError("08006"))
    expect(await verifyEmailByToken(db.client, "tok")).toMatchObject({ error: true, status: 500 })
  })
})

describe("setPrimaryEmail", () => {
  it("promotes a verified, owned address", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_verified: true })],
    })
    db.on(/UPDATE emails SET is_primary/, { rowCount: 1 })
    expect(await setPrimaryEmail(db.client, "user-1", "a@b.test")).toMatchObject({ success: true, status: 200 })
  })

  it("rejects an address owned by another user with 403", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else" })] })
    expect((await setPrimaryEmail(db.client, "user-1", "a@b.test")).status).toBe(403)
  })

  it("rejects an unverified address with 400", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_verified: false })],
    })
    expect((await setPrimaryEmail(db.client, "user-1", "a@b.test")).status).toBe(400)
  })

  it("returns 404 when the address is not found", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    expect((await setPrimaryEmail(db.client, "user-1", "a@b.test")).status).toBe(404)
  })

  it("returns 500 when reading the address errors", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, pgError("08006"))
    expect((await setPrimaryEmail(db.client, "user-1", "a@b.test")).status).toBe(500)
  })

  it("rolls back with 500 when the promote affects no rows", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_verified: true })] })
    db.on(/is_primary = FALSE/, { rowCount: 1 }) // demote
    db.on(/is_primary = TRUE/, { rowCount: 0 }) // promote — unexpectedly hits nothing
    const result = await setPrimaryEmail(db.client, "user-1", "a@b.test")
    expect(result).toMatchObject({ error: true, status: 500 })
    expect(db.calls.map((c) => c.text)).toContain("ROLLBACK")
  })

  it("re-throws when the transaction fails unexpectedly", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_verified: true })] })
    db.on(/is_primary = FALSE/, pgError("08006")) // demote throws (non-retryable)
    await expect(setPrimaryEmail(db.client, "user-1", "a@b.test")).rejects.toThrow()
  })
})

describe("deleteEmail", () => {
  it("removes a non-primary, owned address", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_primary: false })],
    })
    db.on(/DELETE FROM emails/, { rowCount: 1 })
    expect(await deleteEmail(db.client, "user-1", "a@b.test")).toMatchObject({
      success: true,
      status: 200,
    })
  })

  it("refuses to remove the primary address with 400", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_primary: true })],
    })
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(400)
  })

  it("rejects an address owned by another user with 403", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else" })] })
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(403)
  })

  it("returns 404 when the address is not found", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [] })
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(404)
  })

  it("returns 500 when reading the address errors", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, pgError("08006"))
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(500)
  })

  it("returns 404 when the delete affects no rows", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_primary: false })] })
    db.on(/DELETE FROM emails/, { rowCount: 0 })
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(404)
  })

  it("re-throws when the delete fails", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "user-1", is_primary: false })] })
    db.on(/DELETE FROM emails/, pgError("08006"))
    await expect(deleteEmail(db.client, "user-1", "a@b.test")).rejects.toThrow()
  })
})
