import { describe, it, expect } from "vitest"
import {
  hashWithAlgo,
  puff_hashing_password,
  puffHashSha1Hibp,
  passwordNeedsUpgrade,
  PREFERRED_PASSWORD_ALGO,
} from "../../src/utilities/hashing.js"

describe("hashWithAlgo", () => {
  it('produces the known SHA-1 digest of "password"', async () => {
    // 5baa61e4... is the canonical SHA-1 of the string "password".
    expect(await hashWithAlgo("password", "SHA-1")).toBe("5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8")
  })

  it("returns a lower-case hex digest of the algorithm's width", async () => {
    const sha256 = await hashWithAlgo("anything", "SHA-256")
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
    const sha384 = await hashWithAlgo("anything", "SHA-384")
    expect(sha384).toMatch(/^[0-9a-f]{96}$/)
  })
})

describe("puff_hashing_password", () => {
  it("generates a random UUID salt when none is supplied", async () => {
    const result = await puff_hashing_password("hunter2")
    expect(result.salt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(result.algo).toBe(PREFERRED_PASSWORD_ALGO)
    expect(result.hash).toMatch(/^[0-9a-f]{96}$/)
  })

  it("echoes back a supplied salt and is deterministic for it", async () => {
    const a = await puff_hashing_password("hunter2", "fixed-salt")
    const b = await puff_hashing_password("hunter2", "fixed-salt")
    expect(a.salt).toBe("fixed-salt")
    expect(a.hash).toBe(b.hash)
  })

  it("produces a different hash for a different salt", async () => {
    const a = await puff_hashing_password("hunter2", "salt-a")
    const b = await puff_hashing_password("hunter2", "salt-b")
    expect(a.hash).not.toBe(b.hash)
  })

  it("produces a different hash for a different password", async () => {
    const a = await puff_hashing_password("hunter2", "fixed-salt")
    const b = await puff_hashing_password("hunter3", "fixed-salt")
    expect(a.hash).not.toBe(b.hash)
  })

  it("honours an explicit algorithm", async () => {
    const result = await puff_hashing_password("hunter2", "fixed-salt", "SHA-256")
    expect(result.algo).toBe("SHA-256")
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("puffHashSha1Hibp", () => {
  it("splits the SHA-1 digest into a 5-char prefix and 35-char suffix", async () => {
    const { f5, l35 } = await puffHashSha1Hibp("password")
    expect(f5).toBe("5baa6")
    expect(l35).toBe("1e4c9b93f3f0682250b6cf8331b7ee68fd8")
    expect(f5 + l35).toBe("5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8")
  })
})

describe("passwordNeedsUpgrade", () => {
  it("is false for the preferred algorithm", () => {
    expect(passwordNeedsUpgrade(PREFERRED_PASSWORD_ALGO)).toBe(false)
    expect(passwordNeedsUpgrade("SHA-384")).toBe(false)
  })

  it("is true for any other algorithm", () => {
    expect(passwordNeedsUpgrade("SHA-1")).toBe(true)
    expect(passwordNeedsUpgrade("SHA-256")).toBe(true)
    expect(passwordNeedsUpgrade("MD5")).toBe(true)
  })
})
