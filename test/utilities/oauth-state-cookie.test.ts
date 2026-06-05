import { describe, it, expect } from "vitest"
import {
  setOAuthStateCookie,
  readOAuthStateCookie,
  clearOAuthStateCookie,
  generateState,
  generatePkcePair,
  type OAuthStateCookie,
} from "../../src/utilities/oauth-state-cookie.js"
import { encodeString } from "../../src/utilities/base64url.js"
import { verifyPkce } from "../../src/oauth.js"
import { fakeEnv } from "../helpers/fake-env.js"

const value: OAuthStateCookie = {
  provider: "github",
  state: "state-abc",
  code_verifier: "v".repeat(64),
}

describe("setOAuthStateCookie", () => {
  it("encodes the state as base64url JSON scoped to /login with a 10-minute Max-Age", () => {
    const cookie = setOAuthStateCookie(fakeEnv(), value)
    expect(cookie.startsWith("oauth_state=")).toBe(true)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Path=/login")
    expect(cookie).toContain("Max-Age=600")
    expect(cookie).toContain("SameSite=Lax")
  })

  it("appends Secure only when SECURE_COOKIE is set", () => {
    expect(setOAuthStateCookie(fakeEnv({ SECURE_COOKIE: "true" }), value)).toContain("Secure")
    expect(setOAuthStateCookie(fakeEnv(), value)).not.toContain("Secure")
  })
})

describe("readOAuthStateCookie", () => {
  it("round-trips a cookie written by setOAuthStateCookie", async () => {
    const header = setOAuthStateCookie(fakeEnv(), value).split(";")[0]
    expect(await readOAuthStateCookie(header)).toEqual(value)
  })

  it("returns null for a missing header or a header without the cookie", async () => {
    expect(await readOAuthStateCookie(null)).toBeNull()
    expect(await readOAuthStateCookie("other=1")).toBeNull()
  })

  it("returns null when the body is not valid base64url JSON", async () => {
    expect(await readOAuthStateCookie("oauth_state=not-json")).toBeNull()
  })

  it("returns null when a required field is missing", async () => {
    const partial = "oauth_state=" + encodeString(JSON.stringify({ provider: "github", state: "x" }))
    expect(await readOAuthStateCookie(partial)).toBeNull()
  })
})

describe("clearOAuthStateCookie", () => {
  it("expires the cookie with Max-Age=0 on the same path", () => {
    const cookie = clearOAuthStateCookie(fakeEnv())
    expect(cookie).toContain("oauth_state=")
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("Path=/login")
  })

  it("appends Secure only when SECURE_COOKIE is set", () => {
    expect(clearOAuthStateCookie(fakeEnv({ SECURE_COOKIE: "true" }))).toContain("Secure")
    expect(clearOAuthStateCookie(fakeEnv())).not.toContain("Secure")
  })
})

describe("generateState", () => {
  it("produces fresh base64url entropy each call", () => {
    const a = generateState()
    const b = generateState()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(43)
    expect(a).not.toBe(b)
  })
})

describe("generatePkcePair", () => {
  it("produces a verifier whose S256 challenge verifies against oauth.verifyPkce", async () => {
    const { verifier, challenge } = await generatePkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await verifyPkce(verifier, challenge, "S256")).toBe(true)
  })

  it("generates a distinct pair each call", async () => {
    const first = await generatePkcePair()
    const second = await generatePkcePair()
    expect(first.verifier).not.toBe(second.verifier)
  })
})
