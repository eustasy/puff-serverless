import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "../helpers/fake-db.js"
import { fakeEnv } from "../helpers/fake-env.js"
import { generatePkcePair } from "../../src/utilities/oauth-state-cookie.js"

// The grant handlers orchestrate real PKCE verification + token serialisation
// over mocked grant storage, floating-seat allocation, and token minting.
const mocks = vi.hoisted(() => ({
  consumeAuthorizationCode: vi.fn(),
  consumeRefreshToken: vi.fn(),
  createRefreshToken: vi.fn(),
  revokeRefreshTokenChain: vi.fn(),
  checkoutFloatingSeat: vi.fn(),
  releaseFloatingSeat: vi.fn(),
  buildAccessToken: vi.fn(),
  buildIdToken: vi.fn(),
}))
vi.mock("../../src/oauth-grants.js", () => ({
  consumeAuthorizationCode: mocks.consumeAuthorizationCode,
  consumeRefreshToken: mocks.consumeRefreshToken,
  createRefreshToken: mocks.createRefreshToken,
  revokeRefreshTokenChain: mocks.revokeRefreshTokenChain,
}))
vi.mock("../../src/app-floating-sessions.js", () => ({
  checkoutFloatingSeat: mocks.checkoutFloatingSeat,
  releaseFloatingSeat: mocks.releaseFloatingSeat,
}))
// Keep tokenResponse + ACCESS_TOKEN_TTL_SECONDS real; only stub the JWT builders.
vi.mock("../../src/utilities/oauth-token.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utilities/oauth-token.js")>()
  return { ...actual, buildAccessToken: mocks.buildAccessToken, buildIdToken: mocks.buildIdToken }
})

const { handleAuthorizationCodeGrant, handleRefreshTokenGrant } = await import("../../src/utilities/oauth-token-grants.js")

const env = fakeEnv()
const issuer = "https://issuer.example"
const appWith = (mode: AppRow["app_licensing_mode"]) => ({ app_uuid: "a1", client_id: "client-1", app_licensing_mode: mode }) as AppRow
const db = () => new FakeDb().client

beforeEach(() => {
  vi.clearAllMocks()
  mocks.buildAccessToken.mockResolvedValue("access-token")
  mocks.buildIdToken.mockResolvedValue("id-token")
})

describe("handleAuthorizationCodeGrant", () => {
  async function codeGrant(over: { scopes?: string[]; org_uuid?: string | null } = {}) {
    const pair = await generatePkcePair()
    mocks.consumeAuthorizationCode.mockResolvedValue({
      success: true,
      grant: {
        code_challenge: pair.challenge,
        code_challenge_method: "S256",
        scopes: over.scopes ?? ["openid"],
        org_uuid: over.org_uuid ?? null,
        user_uuid: "u1",
        nonce: "n1",
      },
    })
    const form = new URLSearchParams({ code: "the-code", redirect_uri: "https://app/cb", code_verifier: pair.verifier })
    return { pair, form }
  }

  it("400s when code, redirect_uri or code_verifier is missing", async () => {
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), new URLSearchParams(), issuer)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  })

  it("500s on a DB error consuming the code", async () => {
    mocks.consumeAuthorizationCode.mockResolvedValue({ error: true, message: "db" })
    const form = new URLSearchParams({ code: "c", redirect_uri: "r", code_verifier: "v" })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: "server_error" })
  })

  it("rejects an unredeemable code as invalid_grant", async () => {
    mocks.consumeAuthorizationCode.mockResolvedValue({ success: false, message: "expired" })
    const form = new URLSearchParams({ code: "c", redirect_uri: "r", code_verifier: "v" })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
  })

  it("rejects a code with no stored PKCE challenge", async () => {
    mocks.consumeAuthorizationCode.mockResolvedValue({
      success: true,
      grant: { code_challenge: null, code_challenge_method: null, scopes: ["openid"], org_uuid: null, user_uuid: "u1", nonce: null },
    })
    const form = new URLSearchParams({ code: "c", redirect_uri: "r", code_verifier: "v" })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
  })

  it("rejects a mismatched PKCE verifier", async () => {
    const { form } = await codeGrant()
    form.set("code_verifier", (await generatePkcePair()).verifier) // wrong verifier
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
  })

  it("mints an access + id token on success without a refresh token", async () => {
    const { form } = await codeGrant()
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
      id_token: "id-token",
    })
    expect(body).not.toHaveProperty("refresh_token")
    expect(mocks.createRefreshToken).not.toHaveBeenCalled()
  })

  it("issues a refresh token when offline_access is granted", async () => {
    mocks.createRefreshToken.mockResolvedValue({ success: true, token: "refresh-1" })
    const { form } = await codeGrant({ scopes: ["openid", "offline_access"] })
    const body = await (await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)).json()
    expect(body).toMatchObject({ refresh_token: "refresh-1" })
  })

  it("tolerates a refresh-token mint failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.createRefreshToken.mockResolvedValue({ success: false, message: "nope" })
    const { form } = await codeGrant({ scopes: ["openid", "offline_access"] })
    const body = await (await handleAuthorizationCodeGrant(env, db(), appWith("none"), form, issuer)).json()
    expect(body).not.toHaveProperty("refresh_token")
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("denies a floating app with no org context", async () => {
    const { form } = await codeGrant({ org_uuid: null })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("floating"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
    expect(mocks.checkoutFloatingSeat).not.toHaveBeenCalled()
  })

  it("denies a floating app when the seat pool is exhausted", async () => {
    mocks.checkoutFloatingSeat.mockResolvedValue({ success: false, message: "pool full" })
    const { form } = await codeGrant({ org_uuid: "o1" })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("floating"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "access_denied" })
    expect(mocks.releaseFloatingSeat).not.toHaveBeenCalled()
  })

  it("issues tokens for a floating app once a seat is claimed", async () => {
    mocks.checkoutFloatingSeat.mockResolvedValue({ success: true })
    const { form } = await codeGrant({ org_uuid: "o1" })
    const response = await handleAuthorizationCodeGrant(env, db(), appWith("floating"), form, issuer)
    expect(response.status).toBe(200)
    expect(mocks.checkoutFloatingSeat).toHaveBeenCalledOnce()
  })
})

describe("handleRefreshTokenGrant", () => {
  const okGrant = { scopes: ["openid"], org_uuid: null as string | null, user_uuid: "u1", grant_value: "gv-1" }

  it("400s without a refresh_token", async () => {
    const response = await handleRefreshTokenGrant(env, db(), appWith("none"), new URLSearchParams(), issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  })

  it("500s on a DB error consuming the token", async () => {
    mocks.consumeRefreshToken.mockResolvedValue({ error: true, message: "db" })
    const form = new URLSearchParams({ refresh_token: "rt" })
    expect((await handleRefreshTokenGrant(env, db(), appWith("none"), form, issuer)).status).toBe(500)
  })

  it("revokes the whole chain on a failed consume (suspected reuse)", async () => {
    mocks.consumeRefreshToken.mockResolvedValue({ success: false, message: "already used" })
    const form = new URLSearchParams({ refresh_token: "leaked" })
    const response = await handleRefreshTokenGrant(env, db(), appWith("none"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "invalid_grant" })
    expect(mocks.revokeRefreshTokenChain).toHaveBeenCalledWith(expect.anything(), "leaked")
  })

  it("rotates the refresh token and mints fresh access/id tokens", async () => {
    mocks.consumeRefreshToken.mockResolvedValue({ success: true, grant: okGrant })
    mocks.createRefreshToken.mockResolvedValue({ success: true, token: "rotated-1" })
    const form = new URLSearchParams({ refresh_token: "rt" })
    const body = await (await handleRefreshTokenGrant(env, db(), appWith("none"), form, issuer)).json()
    expect(body).toMatchObject({ access_token: "access-token", refresh_token: "rotated-1", id_token: "id-token" })
  })

  it("500s when rotation fails", async () => {
    mocks.consumeRefreshToken.mockResolvedValue({ success: true, grant: okGrant })
    mocks.createRefreshToken.mockResolvedValue({ error: true, message: "nope" })
    const form = new URLSearchParams({ refresh_token: "rt" })
    expect((await handleRefreshTokenGrant(env, db(), appWith("none"), form, issuer)).status).toBe(500)
  })

  it("frees a held seat when a floating refresh finds the pool exhausted", async () => {
    mocks.consumeRefreshToken.mockResolvedValue({ success: true, grant: { ...okGrant, org_uuid: "o1" } })
    mocks.checkoutFloatingSeat.mockResolvedValue({ success: false, message: "pool full" })
    const form = new URLSearchParams({ refresh_token: "rt" })
    const response = await handleRefreshTokenGrant(env, db(), appWith("floating"), form, issuer)
    expect(await response.json()).toMatchObject({ error: "access_denied" })
    expect(mocks.releaseFloatingSeat).toHaveBeenCalledWith(expect.anything(), "a1", "o1", "u1")
  })
})
