import { describe, it, expect, vi, afterEach } from "vitest"
import {
  createPassword,
  readPassword,
  disablePassword,
  updatePassword,
  verifyPassword,
  isPasswordReused,
  minPasswordLength,
  passwordConfig,
  passwordRequirements,
  DEFAULT_MIN_PASSWORD_LENGTH,
} from "../src/passwords.js"
import { puff_hashing_password } from "../src/utilities/hashing.js"
import { FakeDb, pgError } from "./helpers/fake-db.js"
import { fakeEnv } from "./helpers/fake-env.js"

afterEach(() => vi.unstubAllGlobals())

describe("minPasswordLength", () => {
  it("falls back to the floor when unset, non-numeric or below the floor", () => {
    expect(minPasswordLength(fakeEnv())).toBe(DEFAULT_MIN_PASSWORD_LENGTH)
    expect(minPasswordLength(fakeEnv({ MIN_PASSWORD_LENGTH: "abc" }))).toBe(
      DEFAULT_MIN_PASSWORD_LENGTH
    )
    expect(minPasswordLength(fakeEnv({ MIN_PASSWORD_LENGTH: "4" }))).toBe(
      DEFAULT_MIN_PASSWORD_LENGTH
    )
  })

  it("raises the minimum when configured above the floor", () => {
    expect(minPasswordLength(fakeEnv({ MIN_PASSWORD_LENGTH: "20" }))).toBe(20)
  })
})

describe("passwordConfig", () => {
  it("maps the policy env flags", () => {
    const cfg = passwordConfig(
      fakeEnv({
        REQUIRE_NUMBER: "true",
        REQUIRE_CAPITAL: "true",
        REQUIRE_SPECIAL_CHAR: "true",
        REQUIRE_NOT_COMPROMISED: "true",
      })
    )
    expect(cfg).toMatchObject({
      requireNumber: true,
      requireCapital: true,
      requireSpecial: true,
      requireNotCompromised: true,
    })
  })

  it("forces showZxcvbn on when zxcvbn is the hard gate", () => {
    const cfg = passwordConfig(fakeEnv({ REQUIRE_ZXCVBN: "true" }))
    expect(cfg.requireZxcvbn).toBe(true)
    expect(cfg.showZxcvbn).toBe(true)
  })
})

describe("passwordRequirements", () => {
  it("rejects a password shorter than the minimum length", async () => {
    expect(await passwordRequirements("short", 12)).toBe(false)
  })

  it("accepts a long-enough password under a length-only policy", async () => {
    expect(await passwordRequirements("abcdefghijkl", 12)).toBe(true)
  })

  it("enforces character-class rules when configured", async () => {
    const cfg = passwordConfig(
      fakeEnv({ REQUIRE_NUMBER: "true", REQUIRE_CAPITAL: "true" })
    )
    expect(await passwordRequirements("abcdefghijkl", cfg)).toBe(false)
    expect(await passwordRequirements("Abcdefghijk1", cfg)).toBe(true)
  })

  it("treats a HIBP outage as a pass (fail-open)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    const cfg = passwordConfig(fakeEnv({ REQUIRE_NOT_COMPROMISED: "true" }))
    expect(await passwordRequirements("abcdefghijkl", cfg)).toBe(true)
  })
})

describe("createPassword", () => {
  it("rejects a password that fails the requirements with 400", async () => {
    const db = new FakeDb()
    const result = await createPassword(db.client, "user-1", "short")
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls).toHaveLength(0)
  })

  it("stores a SHA-384 hash:salt secret and returns 200", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO secrets/, { rows: [{ user_uuid: "user-1" }] })
    const result = await createPassword(db.client, "user-1", "abcdefghijkl")
    expect(result).toMatchObject({ success: true, status: 200 })
    expect(db.calls[0].values[2]).toBe("puff_password_SHA-384")
    expect(db.calls[0].values[3]).toMatch(/^[0-9a-f]{96}:.+/)
  })

  it("returns 500 when the insert throws", async () => {
    const db = new FakeDb()
    db.on(/INSERT INTO secrets/, pgError("08006"))
    expect((await createPassword(db.client, "u", "abcdefghijkl")).status).toBe(
      500
    )
  })
})

describe("readPassword", () => {
  it("returns the active secret value and parsed algorithm", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, {
      rows: [
        { secret_value: "hash:salt", secret_type: "puff_password_SHA-384" },
      ],
    })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    expect(await readPassword(db.client, "user-1")).toEqual({
      success: true,
      secret_value: "hash:salt",
      algo: "SHA-384",
      status: 200,
    })
  })

  it("returns 404 when the user has no active password", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, { rows: [] })
    expect((await readPassword(db.client, "user-1")).status).toBe(404)
  })
})

describe("disablePassword", () => {
  it("reports disabled: true when an active password was disabled", async () => {
    const db = new FakeDb()
    db.on(/UPDATE secrets/, { rows: [{ user_uuid: "user-1" }] })
    expect(await disablePassword(db.client, "user-1")).toMatchObject({
      success: true,
      disabled: true,
    })
  })

  it("reports disabled: false when there was no active password", async () => {
    const db = new FakeDb()
    db.on(/UPDATE secrets/, { rows: [] })
    expect(await disablePassword(db.client, "user-1")).toMatchObject({
      success: true,
      disabled: false,
    })
  })
})

describe("verifyPassword", () => {
  const storedFor = async (pw: string, algo = "SHA-384") => {
    const { hash, salt } = await puff_hashing_password(pw, "the-salt", algo)
    return {
      secret_value: `${hash}:${salt}`,
      secret_type: `puff_password_${algo}`,
    }
  }

  it("verifies the correct password", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, { rows: [await storedFor("right pw")] })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    expect(await verifyPassword(db.client, "user-1", "right pw")).toEqual({
      success: true,
      verified: true,
      needs_upgrade: false,
      status: 200,
    })
  })

  it("rejects the wrong password", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, { rows: [await storedFor("right pw")] })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    const result = await verifyPassword(db.client, "user-1", "wrong pw")
    expect(result).toMatchObject({ success: true, verified: false })
  })

  it("flags a password stored under an outdated algorithm for upgrade", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, {
      rows: [await storedFor("right pw", "SHA-256")],
    })
    db.on(/UPDATE secrets/, { rowCount: 1 })
    const result = await verifyPassword(db.client, "user-1", "right pw")
    expect(result).toMatchObject({ verified: true, needs_upgrade: true })
  })

  it("reports verified: false (not an error) when no password is set", async () => {
    const db = new FakeDb()
    db.on(/secret_value, secret_type/, { rows: [] })
    expect(await verifyPassword(db.client, "user-1", "anything")).toMatchObject(
      {
        success: true,
        verified: false,
      }
    )
  })
})

describe("isPasswordReused", () => {
  it("detects a candidate matching any historical password", async () => {
    const { hash, salt } = await puff_hashing_password(
      "old password",
      "s1",
      "SHA-384"
    )
    const db = new FakeDb()
    db.on(/secret_type, secret_value/, {
      rows: [
        {
          secret_type: "puff_password_SHA-384",
          secret_value: `${hash}:${salt}`,
        },
      ],
    })
    expect(await isPasswordReused(db.client, "user-1", "old password")).toEqual(
      {
        success: true,
        reused: true,
        status: 200,
      }
    )
  })

  it("returns reused: false when nothing matches", async () => {
    const db = new FakeDb()
    db.on(/secret_type, secret_value/, {
      rows: [
        { secret_type: "puff_password_SHA-384", secret_value: "deadbeef:s1" },
      ],
    })
    expect(
      await isPasswordReused(db.client, "user-1", "a different password")
    ).toMatchObject({ reused: false })
  })
})

describe("updatePassword", () => {
  it("disables the old password and creates the new one", async () => {
    const db = new FakeDb()
    db.on(/SET is_enabled = FALSE/, {
      rows: [{ user_uuid: "user-1" }],
    })
    db.on(/INSERT INTO secrets/, { rows: [{ user_uuid: "user-1" }] })
    expect(await updatePassword(db.client, "user-1", "abcdefghijkl")).toEqual({
      success: true,
      status: 200,
    })
  })

  it("propagates a validation failure and rolls back", async () => {
    const db = new FakeDb()
    db.on(/SET is_enabled = FALSE/, { rows: [] })
    const result = await updatePassword(db.client, "user-1", "short")
    expect(result).toMatchObject({ success: false, status: 400 })
    expect(db.calls.map((c) => c.text)).toContain("ROLLBACK")
  })
})
