// Inverse of Uint8toHex. Currently unused (kept as the symmetric counterpart);
// the `_` prefix marks it intentionally unused so the linter stays quiet.
/* v8 ignore start -- intentionally unused; kept only as the symmetric counterpart of Uint8toHex */
function _HextoUint8(hexString: string) {
  return Uint8Array.from((hexString.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)))
}
/* v8 ignore stop */

function Uint8toHex(bytes: Uint8Array) {
  return bytes.reduce((str: string, byte: number) => str + byte.toString(16).padStart(2, "0"), "")
}

/** Hashes pw with the given Web Crypto algorithm name (e.g. "SHA-256", "SHA-384", "SHA-1") and returns the hex digest. */
export async function hashWithAlgo(pw: string, algo: string) {
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest({ name: algo }, myText)
  const bitsBack = new Uint8Array(myDigest)
  const hash = Uint8toHex(bitsBack)
  return hash
}

// The hash algorithm new passwords are stored with. verifyPassword flags any
// active hash stored under a different algorithm as needing an upgrade, and
// loginUser transparently re-hashes it on the next successful login.
export const PREFERRED_PASSWORD_ALGO = "SHA-384"

// True if a stored password hash uses an algorithm other than the current
// preferred one, and so should be transparently re-hashed on the next login.
export function passwordNeedsUpgrade(algo: string) {
  return algo !== PREFERRED_PASSWORD_ALGO
}

// puff_hashing_password(pw, salt = "", algo = PREFERRED_PASSWORD_ALGO)
// salt is optional, if not provided, a random UUID will be generated
// algo can be "SHA-1", "SHA-256", "SHA-384", "SHA-512", or "MD5"
// - source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms
// returns an object with the hash and salt
// example:
// const { hash, salt } = await puff_hashing_password("myPassword123", "", "SHA-384")
// returns { hash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z", salt: "random-uuid" }
export async function puff_hashing_password(pw: string, salt = "", algo = PREFERRED_PASSWORD_ALGO) {
  if (salt.length === 0) {
    salt = crypto.randomUUID()
  }

  const toHash = pw + salt
  const hash = await hashWithAlgo(toHash, algo)

  const hashes = {
    hash: hash,
    salt: salt,
    algo: algo,
  }
  return hashes
}

/** SHA-1 hashes pw and returns the first 5 hex chars (f5) and the remaining 35 (l35) for a HIBP k-anonymity lookup. */
export async function puffHashSha1Hibp(pw: string) {
  const pw_sha1 = await hashWithAlgo(pw, "SHA-1")

  const pw_sha1_f5 = pw_sha1.slice(0, 5)
  const pw_sha1_l35 = pw_sha1.slice(5, 40)

  const slices = {
    f5: pw_sha1_f5,
    l35: pw_sha1_l35,
  }
  return slices
}
