import { describe, it, expect } from "vitest"
import { fakeContext } from "../helpers/fake-context.js"
import { fakeEnv } from "../helpers/fake-env.js"
import { operatorAuthMiddleware } from "../../src/utilities/operator-auth.js"

const OPERATOR = "11111111-1111-1111-1111-111111111111"
const OUTSIDER = "22222222-2222-2222-2222-222222222222"

// `operators: undefined` leaves OPERATOR_USER_UUIDS unset entirely.
function build(opts: { user_uuid?: string; operators?: string }) {
  let nextCalled = false
  const env = opts.operators === undefined ? fakeEnv() : fakeEnv({ OPERATOR_USER_UUIDS: opts.operators })
  const context = fakeContext({
    env,
    data: { user_uuid: opts.user_uuid },
    next: async () => {
      nextCalled = true
      return new Response("granted", { status: 200 })
    },
  })
  return { context, nextCalled: () => nextCalled }
}

describe("operatorAuthMiddleware", () => {
  it("returns 503 when OPERATOR_USER_UUIDS is unset (locked-down default)", async () => {
    const { context, nextCalled } = build({ user_uuid: OPERATOR })

    const response = await operatorAuthMiddleware(context)

    expect(response.status).toBe(503)
    expect(nextCalled()).toBe(false)
    expect(await response.text()).toContain("disabled")
  })

  it("returns 503 when OPERATOR_USER_UUIDS is present but empty", async () => {
    const { context, nextCalled } = build({ user_uuid: OPERATOR, operators: "   " })

    const response = await operatorAuthMiddleware(context)

    expect(response.status).toBe(503)
    expect(nextCalled()).toBe(false)
  })

  it("returns 403 for an authenticated user who is not an operator", async () => {
    const { context, nextCalled } = build({ user_uuid: OUTSIDER, operators: OPERATOR })

    const response = await operatorAuthMiddleware(context)

    expect(response.status).toBe(403)
    expect(nextCalled()).toBe(false)
    expect(await response.text()).toContain("Not authorised")
  })

  it("returns 403 when no user_uuid was populated upstream", async () => {
    const { context, nextCalled } = build({ user_uuid: undefined, operators: OPERATOR })

    const response = await operatorAuthMiddleware(context)

    expect(response.status).toBe(403)
    expect(nextCalled()).toBe(false)
  })

  it("calls next() for a listed operator (comma/whitespace-separated list)", async () => {
    const { context, nextCalled } = build({ user_uuid: OPERATOR, operators: `${OUTSIDER}, ${OPERATOR}` })

    const response = await operatorAuthMiddleware(context)

    expect(nextCalled()).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("granted")
  })
})
