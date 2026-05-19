import { describe, it, expect, vi, afterEach } from "vitest"
import {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendTwoFactorBypassEmail,
} from "../src/mailer.js"
import { fakeEnv } from "./helpers/fake-env.js"

afterEach(() => vi.unstubAllGlobals())

// Stubs global fetch with a recording mock that resolves to `response`.
// The args are typed so `.mock.calls` carries the URL and init object.
function stubFetch(response: Response) {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(response)
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// The JSON body the mailer POSTed on the mock's first call.
function sentBody(fetchMock: ReturnType<typeof stubFetch>): {
  to: { email: string }[]
  subject: string
  text: string
  html?: string
  category?: string
} {
  return JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
}

const configured = fakeEnv({
  MAILTRAP_TOKEN: "tok",
  MAILTRAP_SENDER: "noreply@example.com",
  APP_URL: "https://app.example.com",
})

describe("sendEmail", () => {
  it("returns 500 when Mailtrap is not configured", async () => {
    const result = await sendEmail(fakeEnv(), {
      to: "a@b.test",
      subject: "Hi",
      text: "body",
    })
    expect(result).toMatchObject({ error: true, status: 500 })
  })

  it("posts the message and returns 200 when Mailtrap accepts it", async () => {
    const fetchMock = stubFetch(new Response("", { status: 200 }))
    const result = await sendEmail(configured, {
      to: "a@b.test",
      subject: "Hi",
      text: "body",
      html: "<p>body</p>",
      category: "Test",
    })
    expect(result).toMatchObject({ success: true, status: 200 })

    expect(fetchMock.mock.calls[0][1]!.method).toBe("POST")
    const body = sentBody(fetchMock)
    expect(body.to).toEqual([{ email: "a@b.test" }])
    expect(body.html).toBe("<p>body</p>")
    expect(body.category).toBe("Test")
  })

  it("returns 502 when Mailtrap responds with an error status", async () => {
    stubFetch(new Response("nope", { status: 422 }))
    const result = await sendEmail(configured, {
      to: "a@b.test",
      subject: "Hi",
      text: "body",
    })
    expect(result).toMatchObject({ error: true, status: 502 })
  })

  it("returns 502 when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    const result = await sendEmail(configured, {
      to: "a@b.test",
      subject: "Hi",
      text: "body",
    })
    expect(result).toMatchObject({ error: true, status: 502 })
  })
})

describe("templated senders", () => {
  it("returns 500 when APP_URL is unset (links would be unusable)", async () => {
    const env = fakeEnv({ MAILTRAP_TOKEN: "t", MAILTRAP_SENDER: "s@e.test" })
    expect(await sendVerificationEmail(env, "a@b.test", "tok")).toMatchObject({
      error: true,
      status: 500,
    })
  })

  it("sendVerificationEmail builds an absolute verify link with the token", async () => {
    const fetchMock = stubFetch(new Response("", { status: 200 }))
    await sendVerificationEmail(configured, "a@b.test", "tok 123")
    expect(sentBody(fetchMock).text).toContain(
      "https://app.example.com/api/db/email/verify?token=tok%20123"
    )
  })

  it("sendPasswordResetEmail builds an absolute reset link", async () => {
    const fetchMock = stubFetch(new Response("", { status: 200 }))
    await sendPasswordResetEmail(configured, "a@b.test", "rtok")
    expect(sentBody(fetchMock).text).toContain(
      "https://app.example.com/reset/set?token=rtok"
    )
  })

  it("sendTwoFactorBypassEmail builds an absolute bypass link", async () => {
    const fetchMock = stubFetch(new Response("", { status: 200 }))
    await sendTwoFactorBypassEmail(configured, "a@b.test", "btok")
    expect(sentBody(fetchMock).text).toContain(
      "https://app.example.com/api/db/2fa/bypass/verify?token=btok"
    )
  })
})
