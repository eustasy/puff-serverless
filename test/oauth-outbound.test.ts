import { describe, it, expect, vi, afterEach } from "vitest"
import { buildAuthorizeUrl, exchangeCode, fetchUserIdentity } from "../src/oauth-outbound.js"
import type { ProviderConfig } from "../src/oauth-providers.js"

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const provider: ProviderConfig = {
  name: "github",
  display_name: "GitHub",
  authorize_url: "https://gh.example/login/oauth/authorize",
  token_url: "https://gh.example/login/oauth/access_token",
  userinfo_url: "https://api.gh.example/user",
  scopes: ["read:user", "user:email"],
  client_id_env: "GITHUB_CLIENT_ID",
  client_secret_env: "GITHUB_CLIENT_SECRET",
  emails_url: "https://api.gh.example/user/emails",
  normaliseUserinfo: (userinfo, emails) => {
    const u = userinfo as { id?: number; login?: string } | null
    if (!u?.id) return null
    const primary = (emails as { email: string; primary: boolean }[] | undefined)?.find((e) => e.primary)
    return {
      provider_user_id: String(u.id),
      email: primary?.email ?? null,
      email_verified: Boolean(primary),
      display_name: u.login ?? null,
    }
  },
}

describe("buildAuthorizeUrl", () => {
  it("builds an Authorization Code + S256 PKCE URL with the provider scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        provider,
        client_id: "cid",
        redirect_uri: "https://puff.example/cb",
        state: "st",
        code_challenge: "cc",
      })
    )
    expect(url.origin + url.pathname).toBe("https://gh.example/login/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("cid")
    expect(url.searchParams.get("redirect_uri")).toBe("https://puff.example/cb")
    expect(url.searchParams.get("scope")).toBe("read:user user:email")
    expect(url.searchParams.get("state")).toBe("st")
    expect(url.searchParams.get("code_challenge")).toBe("cc")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("access_type")).toBe("offline")
  })
})

describe("exchangeCode", () => {
  const opts = {
    provider,
    client_id: "cid",
    client_secret: "secret",
    code: "auth-code",
    redirect_uri: "https://puff.example/cb",
    code_verifier: "verifier",
  }

  it("posts the code and returns the access + id token", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonResponse({ access_token: "at", id_token: "it" })))
    vi.stubGlobal("fetch", fetchMock)
    const result = await exchangeCode(opts)
    expect(result).toMatchObject({ success: true, access_token: "at", id_token: "it", status: 200 })
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(provider.token_url)
    expect(init?.method).toBe("POST")
    expect(String(init?.body)).toContain("grant_type=authorization_code")
    expect(String(init?.body)).toContain("code_verifier=verifier")
  })

  it("returns null id_token when the provider omits it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ access_token: "at" }))))
    expect(await exchangeCode(opts)).toMatchObject({ success: true, access_token: "at", id_token: null })
  })

  it("fails with 502 on a non-OK token response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("bad", { status: 400 }))))
    expect(await exchangeCode(opts)).toMatchObject({ success: false, status: 502 })
  })

  it("fails with 502 when no access token is returned", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ token_type: "bearer" }))))
    expect(await exchangeCode(opts)).toMatchObject({ success: false, status: 502 })
  })

  it("returns a 502 error envelope on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))))
    expect(await exchangeCode(opts)).toMatchObject({ error: true, status: 502 })
  })
})

describe("fetchUserIdentity", () => {
  it("normalises the userinfo and the companion emails payload", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/emails") ? jsonResponse([{ email: "ada@example.com", primary: true }]) : jsonResponse({ id: 7, login: "ada" })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    const result = await fetchUserIdentity(provider, "token")
    expect(result).toMatchObject({
      success: true,
      identity: { provider_user_id: "7", email: "ada@example.com", email_verified: true, display_name: "ada" },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("still succeeds when the optional emails fetch throws", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/emails")) return Promise.reject(new Error("emails down"))
      return Promise.resolve(jsonResponse({ id: 7, login: "ada" }))
    })
    vi.stubGlobal("fetch", fetchMock)
    const result = await fetchUserIdentity(provider, "token")
    expect(result).toMatchObject({ success: true, identity: { provider_user_id: "7", email: null, email_verified: false } })
  })

  it("fails with 502 when the userinfo response is not OK", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("no", { status: 401 }))))
    expect(await fetchUserIdentity(provider, "token")).toMatchObject({ success: false, status: 502 })
  })

  it("fails with 502 when the profile cannot be normalised", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ login: "no-id" }))))
    expect(await fetchUserIdentity(provider, "token")).toMatchObject({ success: false, status: 502 })
  })

  it("returns a 502 error envelope on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))))
    expect(await fetchUserIdentity(provider, "token")).toMatchObject({ error: true, status: 502 })
  })
})
