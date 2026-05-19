import { describe, it, expect } from "vitest"
import {
  existsEmail,
  readEmail,
  readEmails,
  createEmail,
  verifyEmailByToken,
  setPrimaryEmail,
  deleteEmail,
} from "../src/emails.js"
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
    const result = await createEmail(
      db.client,
      "user-1",
      "a@b.test",
      true,
      true
    )
    expect(result).toMatchObject({ success: true, token_value: null })
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
})

describe("setPrimaryEmail", () => {
  it("promotes a verified, owned address", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_verified: true })],
    })
    db.on(/UPDATE emails SET is_primary/, { rowCount: 1 })
    expect(
      await setPrimaryEmail(db.client, "user-1", "a@b.test")
    ).toMatchObject({ success: true, status: 200 })
  })

  it("rejects an address owned by another user with 403", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else" })] })
    expect(
      (await setPrimaryEmail(db.client, "user-1", "a@b.test")).status
    ).toBe(403)
  })

  it("rejects an unverified address with 400", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, {
      rows: [emailRow({ user_uuid: "user-1", is_verified: false })],
    })
    expect(
      (await setPrimaryEmail(db.client, "user-1", "a@b.test")).status
    ).toBe(400)
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
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(
      400
    )
  })

  it("rejects an address owned by another user with 403", async () => {
    const db = new FakeDb()
    db.on(READ_EMAIL, { rows: [emailRow({ user_uuid: "someone-else" })] })
    expect((await deleteEmail(db.client, "user-1", "a@b.test")).status).toBe(
      403
    )
  })
})
