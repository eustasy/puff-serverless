import { describe, it, expect } from "vitest"
import {
  getProviderConfig,
  getProviderCredentials,
  isProviderName,
  listConfiguredProviders,
  providerRedirectUri,
} from "../src/oauth-providers.js"
import { fakeEnv } from "./helpers/fake-env.js"

describe("isProviderName", () => {
  it("only accepts the three known providers", () => {
    expect(isProviderName("github")).toBe(true)
    expect(isProviderName("google")).toBe(true)
    expect(isProviderName("microsoft")).toBe(true)
    expect(isProviderName("twitter")).toBe(false)
    expect(isProviderName(42)).toBe(false)
  })
})

describe("getProviderConfig + extractors", () => {
  it("GitHub: pulls id + email from /user, prefers a verified primary from /user/emails", () => {
    const config = getProviderConfig("github")!
    const identity = config.normaliseUserinfo(
      { id: 12345, login: "alice", name: "Alice", email: null },
      [
        { email: "old@x", primary: false, verified: false },
        { email: "alice@x", primary: true, verified: true },
      ]
    )
    expect(identity).toEqual({
      provider_user_id: "12345",
      email: "alice@x",
      email_verified: true,
      display_name: "Alice",
    })
  })

  it("GitHub: falls back to /user.email (unverified) when /user/emails is absent", () => {
    const config = getProviderConfig("github")!
    const identity = config.normaliseUserinfo({
      id: 42,
      login: "bob",
      name: null,
      email: "bob@x",
    })
    expect(identity).toEqual({
      provider_user_id: "42",
      email: "bob@x",
      email_verified: false,
      display_name: "bob",
    })
  })

  it("Google: trusts email_verified from the OIDC userinfo", () => {
    const config = getProviderConfig("google")!
    const identity = config.normaliseUserinfo({
      sub: "g-1",
      email: "carol@x",
      email_verified: true,
      name: "Carol",
    })
    expect(identity).toEqual({
      provider_user_id: "g-1",
      email: "carol@x",
      email_verified: true,
      display_name: "Carol",
    })
  })

  it("Microsoft: without an ID token, marks the email unverified", () => {
    const config = getProviderConfig("microsoft")!
    const identity = config.normaliseUserinfo({
      sub: "ms-1",
      email: "dave@x",
      name: "Dave",
    })
    expect(identity).toEqual({
      provider_user_id: "ms-1",
      email: "dave@x",
      email_verified: false,
      display_name: "Dave",
    })
  })

  it("Microsoft: trusts the email when ID token's tid is a work tenant", () => {
    const config = getProviderConfig("microsoft")!
    // unsigned JWT with payload { tid: "work-tenant-1" }
    const payload = btoa(JSON.stringify({ tid: "work-tenant-1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const idToken = `header.${payload}.sig`
    const identity = config.normaliseUserinfo(
      { sub: "ms-1", email: "dave@corp", name: "Dave" },
      undefined,
      idToken
    )
    expect(identity?.email_verified).toBe(true)
  })

  it("Microsoft: keeps the email unverified for the personal-MSA tenant", () => {
    const config = getProviderConfig("microsoft")!
    const payload = btoa(
      JSON.stringify({ tid: "9188040d-6c67-4c5b-b112-36a304b66dad" })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const idToken = `header.${payload}.sig`
    const identity = config.normaliseUserinfo(
      { sub: "ms-1", email: "dave@outlook.com", name: "Dave" },
      undefined,
      idToken
    )
    expect(identity?.email_verified).toBe(false)
  })

  it("Microsoft: keeps the email unverified when the ID token is malformed", () => {
    const config = getProviderConfig("microsoft")!
    const identity = config.normaliseUserinfo(
      { sub: "ms-1", email: "dave@x", name: "Dave" },
      undefined,
      "not.a.valid.jwt"
    )
    expect(identity?.email_verified).toBe(false)
  })

  it("returns null when the response is missing a stable identifier", () => {
    expect(getProviderConfig("github")!.normaliseUserinfo({})).toBeNull()
    expect(getProviderConfig("google")!.normaliseUserinfo({})).toBeNull()
  })
})

describe("getProviderCredentials + listConfiguredProviders", () => {
  it("returns null when either env var is missing", () => {
    const env = fakeEnv({} as Partial<Env>)
    const config = getProviderConfig("github")!
    expect(getProviderCredentials(env, config)).toBeNull()
  })

  it("returns the credentials when both env vars are set", () => {
    const env = fakeEnv({
      OAUTH_GITHUB_CLIENT_ID: "cid",
      OAUTH_GITHUB_CLIENT_SECRET: "secret",
    } as unknown as Partial<Env>)
    const config = getProviderConfig("github")!
    expect(getProviderCredentials(env, config)).toEqual({
      client_id: "cid",
      client_secret: "secret",
    })
  })

  it("listConfiguredProviders only includes the ones with credentials", () => {
    const env = fakeEnv({
      OAUTH_GOOGLE_CLIENT_ID: "g-cid",
      OAUTH_GOOGLE_CLIENT_SECRET: "g-secret",
    } as unknown as Partial<Env>)
    const list = listConfiguredProviders(env)
    expect(list.map((c) => c.name)).toEqual(["google"])
  })
})

describe("providerRedirectUri", () => {
  it("strips trailing slash from APP_URL and appends /login/{name}/callback", () => {
    const env = fakeEnv({ APP_URL: "https://puff.example/" } as Partial<Env>)
    expect(providerRedirectUri(env, "github")).toBe(
      "https://puff.example/login/github/callback"
    )
  })
})
