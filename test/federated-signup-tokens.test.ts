import { describe, it, expect } from "vitest"
import {
  FEDERATED_SIGNUP_TOKEN_TTL_SECONDS,
  consumeFederatedSignupToken,
  createFederatedSignupToken,
  readFederatedSignupToken,
} from "../src/federated-signup-tokens.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("createFederatedSignupToken", () => {
  it("inserts the token with the configured TTL and the provider data", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO federated_signup_tokens/, { rows: [], rowCount: 1 })
    const r = await createFederatedSignupToken(db.client, {
      provider: "github",
      provider_user_id: "gh-1",
      email: "a@b.test",
      email_verified: true,
      display_name: "Alice",
    })
    expect(r.success).toBe(true)
    const call = db.calls[0]!
    expect(call.values[1]).toBe("github")
    expect(call.values[2]).toBe("gh-1")
    expect(call.values[3]).toBe("a@b.test")
    expect(call.values[4]).toBe(true)
    expect(call.values[5]).toBe("Alice")
    expect(call.values[6]).toBe(FEDERATED_SIGNUP_TOKEN_TTL_SECONDS)
  })

  it("returns a 500 envelope when the insert throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO federated_signup_tokens/, pgError("08006"))
    const r = await createFederatedSignupToken(db.client, {
      provider: "github",
      provider_user_id: "gh-1",
      email: null,
      email_verified: false,
      display_name: null,
    })
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("readFederatedSignupToken", () => {
  it("returns the row when found", async () => {
    const db = new FakeDb()
    db.on(/SELECT[\s\S]*FROM federated_signup_tokens/, {
      rows: [
        {
          token_value: "t-1",
          provider: "github",
          provider_user_id: "gh-1",
          email: "a@b.test",
          email_verified: true,
          display_name: "Alice",
          expires_at: new Date(Date.now() + 60_000),
          created_at: new Date(),
          is_used: false,
        },
      ],
    })
    const r = await readFederatedSignupToken(db.client, "t-1")
    expect(r.success).toBe(true)
  })

  it("collapses missing / used / expired into a single 400", async () => {
    const db = new FakeDb()
    db.on(/SELECT[\s\S]*FROM federated_signup_tokens/, { rows: [] })
    const r = await readFederatedSignupToken(db.client, "t-?")
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(400)
  })

  it("returns a 500 envelope when the query throws", async () => {
    const db = new FakeDb()
    db.on(/SELECT[\s\S]*FROM federated_signup_tokens/, pgError("08006"))
    const r = await readFederatedSignupToken(db.client, "t-1")
    expect(r).toMatchObject({ error: true, status: 500 })
  })
})

describe("consumeFederatedSignupToken", () => {
  it("returns the row on a successful atomic flip", async () => {
    const db = new FakeDb()
    db.on(/UPDATE federated_signup_tokens/, {
      rows: [
        {
          token_value: "t-1",
          provider: "github",
          provider_user_id: "gh-1",
          email: "a@b.test",
          email_verified: true,
          display_name: "Alice",
          expires_at: new Date(Date.now() + 60_000),
          created_at: new Date(),
          is_used: true,
        },
      ],
    })
    const r = await consumeFederatedSignupToken(db.client, "t-1")
    expect(r.success).toBe(true)
  })

  it("returns 400 when the UPDATE matched nothing", async () => {
    const db = new FakeDb()
    db.on(/UPDATE federated_signup_tokens/, { rows: [] })
    const r = await consumeFederatedSignupToken(db.client, "t-?")
    expect(r.success).toBe(false)
    if (!r.success && !r.error) expect(r.status).toBe(400)
  })
})
