import { describe, it, expect } from "vitest"
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createAuthorizationCode,
  createRefreshToken,
  revokeRefreshTokenChain,
} from "../src/oauth-grants.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"

describe("createAuthorizationCode", () => {
  it("inserts the code with PKCE + nonce + scopes and returns the value", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, ({ length }) => ({
      rows: [{ grant_value: "ignored" }],
      rowCount: length,
    }))
    const result = await createAuthorizationCode(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: "o-1",
      scopes: ["openid", "profile"],
      redirect_uri: "https://app.example/cb",
      code_challenge: "ch",
      code_challenge_method: "S256",
      nonce: "n-1",
    })
    expect(result.success).toBe(true)
    const call = db.calls[0]!
    expect(call.text).toMatch(/'authorization_code'/)
    // First positional is the code; subsequent ones are the inputs we passed.
    expect(call.values[1]).toBe("u-1")
    expect(call.values[2]).toBe("a-1")
    expect(call.values[3]).toBe("o-1")
    expect(call.values[4]).toEqual(["openid", "profile"])
    expect(call.values[5]).toBe("https://app.example/cb")
    expect(call.values[6]).toBe("ch")
    expect(call.values[7]).toBe("S256")
    expect(call.values[8]).toBe("n-1")
    expect(call.values[9]).toBe(AUTHORIZATION_CODE_TTL_SECONDS)
  })

  it("returns 500 when the insert returns no row", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, { rows: [] })
    const result = await createAuthorizationCode(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: null,
      scopes: [],
      redirect_uri: "x",
      code_challenge: "c",
      code_challenge_method: "S256",
      nonce: null,
    })
    expect(result).toMatchObject({ error: true, status: 500 })
  })

  it("returns 500 when the DB throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, pgError("08006"))
    const result = await createAuthorizationCode(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: null,
      scopes: [],
      redirect_uri: "x",
      code_challenge: "c",
      code_challenge_method: "S256",
      nonce: null,
    })
    expect(result.status).toBe(500)
  })
})

describe("consumeAuthorizationCode", () => {
  it("returns the row when the atomic UPDATE flipped is_used", async () => {
    const db = new FakeDb()
    const row = {
      grant_value: "c-1",
      grant_type: "authorization_code",
      user_uuid: "u-1",
      app_uuid: "a-1",
      scopes: ["openid"],
      redirect_uri: "https://app.example/cb",
      code_challenge: "ch",
      code_challenge_method: "S256",
      nonce: null,
      parent_grant_value: null,
      expires_at: new Date(),
      created_at: new Date(),
      is_used: true,
    }
    db.on(/UPDATE oauth_grants/, { rows: [row] })
    const result = await consumeAuthorizationCode(db.client, "c-1", "a-1", "https://app.example/cb")
    expect(result.success).toBe(true)
    if (result.success) expect(result.grant.user_uuid).toBe("u-1")
  })

  it("collapses missing/used/expired/wrong-redirect into a single 400", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, { rows: [] })
    const result = await consumeAuthorizationCode(db.client, "c-?", "a-1", "https://app.example/cb")
    expect(result.success).toBe(false)
    expect(result.status).toBe(400)
  })

  it("returns 500 when the DB throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, pgError("08006"))
    const result = await consumeAuthorizationCode(db.client, "c-1", "a-1", "https://app.example/cb")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("createRefreshToken", () => {
  it("inserts the refresh token with parent linkage and 30-day TTL", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, ({ length }) => ({
      rows: [{ grant_value: "ignored" }],
      rowCount: length,
    }))
    const result = await createRefreshToken(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: "o-1",
      scopes: ["openid", "offline_access"],
      parent_grant_value: "rt-old",
    })
    expect(result.success).toBe(true)
    const call = db.calls[0]!
    expect(call.text).toMatch(/'refresh_token'/)
    expect(call.values[3]).toBe("o-1")
    expect(call.values[5]).toBe("rt-old")
    expect(call.values[6]).toBe(REFRESH_TOKEN_TTL_SECONDS)
  })

  it("returns 500 when the insert returns no row", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, { rows: [] })
    const result = await createRefreshToken(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: null,
      scopes: [],
      parent_grant_value: null,
    })
    expect(result).toMatchObject({ error: true, status: 500 })
  })

  it("returns 500 when the DB throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO oauth_grants/, pgError("08006"))
    const result = await createRefreshToken(db.client, {
      user_uuid: "u-1",
      app_uuid: "a-1",
      org_uuid: null,
      scopes: [],
      parent_grant_value: null,
    })
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})

describe("consumeRefreshToken", () => {
  it("returns the row on a successful atomic flip", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, {
      rows: [
        {
          grant_value: "rt-1",
          grant_type: "refresh_token",
          user_uuid: "u-1",
          app_uuid: "a-1",
          scopes: ["openid"],
        },
      ],
    })
    const result = await consumeRefreshToken(db.client, "rt-1", "a-1")
    expect(result.success).toBe(true)
  })

  it("returns 400 when the token is missing/used/expired/wrong-app", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, { rows: [] })
    expect((await consumeRefreshToken(db.client, "rt-?", "a-1")).status).toBe(400)
  })

  it("returns 500 when the DB throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, pgError("08006"))
    expect((await consumeRefreshToken(db.client, "rt-1", "a-1")).status).toBe(500)
  })
})

describe("revokeRefreshTokenChain", () => {
  it("reports how many rows it flipped", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, {
      rows: [{ grant_value: "rt-1" }, { grant_value: "rt-2" }],
    })
    const result = await revokeRefreshTokenChain(db.client, "rt-1")
    expect(result.success).toBe(true)
    if (result.success) expect(result.revoked).toBe(2)
  })

  it("returns 500 when the DB throws", async () => {
    const db = new FakeDb()
    db.on(/UPDATE oauth_grants/, pgError("08006"))
    const result = await revokeRefreshTokenChain(db.client, "rt-1")
    expect(result).toMatchObject({ error: true, status: 500 })
  })
})
