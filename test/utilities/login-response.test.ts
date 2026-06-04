import { describe, it, expect } from "vitest"
import { loginOutcomeResponse } from "../../src/utilities/login-response.js"
import type { UserLoginSuccess } from "../../src/users.js"
import { FakeDb } from "../helpers/fake-db.js"
import { fakeEnv } from "../helpers/fake-env.js"

const request = (cookie?: string): Request =>
  new Request("https://app.example/", {
    headers: cookie ? { Cookie: cookie } : {},
  })

const totpResult: UserLoginSuccess = {
  success: true,
  totp_required: true,
  user_uuid: "user-1",
  message: "2FA required.",
  status: 202,
}

const upgradeResult: UserLoginSuccess = {
  success: true,
  password_upgrade_required: true,
  user_uuid: "user-1",
  message: "Password upgrade required.",
  status: 202,
}

const sessionResult: UserLoginSuccess = {
  success: true,
  session_id: "sess-abc",
  user_uuid: "user-1",
  message: "Login successful.",
  status: 200,
}

describe("loginOutcomeResponse — 2FA required", () => {
  it("issues a pending token cookie and redirects to /2fa", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO tokens/, { rows: [{ token_value: "tok" }] })
    const response = await loginOutcomeResponse(db.client, fakeEnv(), totpResult, request())
    expect(response.status).toBe(303)
    expect(response.headers.get("HX-Redirect")).toBe("/2fa")
    expect(response.headers.get("Set-Cookie")).toContain("totp_verification_token=")
  })

  it("returns 500 when the pending token cannot be created", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO tokens/, { rows: [] })
    const response = await loginOutcomeResponse(db.client, fakeEnv(), totpResult, request())
    expect(response.status).toBe(500)
  })
})

describe("loginOutcomeResponse — password upgrade required", () => {
  it("issues an upgrade token cookie and redirects to /password-upgrade", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO tokens/, { rows: [{ token_value: "tok" }] })
    const response = await loginOutcomeResponse(db.client, fakeEnv(), upgradeResult, request())
    expect(response.status).toBe(303)
    expect(response.headers.get("HX-Redirect")).toBe("/password-upgrade")
    expect(response.headers.get("Set-Cookie")).toContain("password_upgrade_token=")
  })
})

describe("loginOutcomeResponse — session granted", () => {
  it("sets the session cookie and redirects to /account by default", async () => {
    const db = new FakeDb()
    const response = await loginOutcomeResponse(db.client, fakeEnv(), sessionResult, request())
    expect(response.status).toBe(303)
    expect(response.headers.get("HX-Redirect")).toBe("/account")
    expect(response.headers.get("Set-Cookie")).toContain("session_token=sess-abc")
  })

  it("redirects to a safe login_next destination and clears that cookie", async () => {
    const db = new FakeDb()
    const response = await loginOutcomeResponse(db.client, fakeEnv(), sessionResult, request("login_next=%2Fdashboard"))
    expect(response.headers.get("HX-Redirect")).toBe("/dashboard")
    // Two Set-Cookie headers: the session cookie and the next-cookie clear.
    const cookies = response.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith("session_token="))).toBe(true)
    expect(cookies.some((c) => c.startsWith("login_next=") && c.includes("Max-Age=0"))).toBe(true) // prettier-ignore
  })

  it("ignores an unsafe login_next destination", async () => {
    const db = new FakeDb()
    const response = await loginOutcomeResponse(
      db.client,
      fakeEnv(),
      sessionResult,
      request(`login_next=${encodeURIComponent("https://evil.example")}`)
    )
    expect(response.headers.get("HX-Redirect")).toBe("/account")
  })

  it("adds Secure to the session cookie when SECURE_COOKIE is set", async () => {
    const db = new FakeDb()
    const response = await loginOutcomeResponse(db.client, fakeEnv({ SECURE_COOKIE: "true" }), sessionResult, request())
    expect(response.headers.get("Set-Cookie")).toContain("Secure")
  })
})
