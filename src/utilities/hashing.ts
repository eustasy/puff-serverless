function HextoUint8(hexString: string) {
  return Uint8Array.from(
    (hexString.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16))
  )
}

function Uint8toHex(bytes: Uint8Array) {
  return bytes.reduce(
    (str: string, byte: number) => str + byte.toString(16).padStart(2, "0"),
    ""
  )
}

export async function hashing_wrapper(pw: string, algo: string) {
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest({ name: algo }, myText)
  const bitsBack = new Uint8Array(myDigest)
  const hash = Uint8toHex(bitsBack)
  return hash
}

// puff_hashing_password(pw, salt = "", algo = "SHA-384")
// salt is optional, if not provided, a random UUID will be generated
// algo can be "SHA-1", "SHA-256", "SHA-384", "SHA-512", or "MD5"
// - source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms
// returns an object with the hash and salt
// example:
// const { hash, salt } = await puff_hashing_password("myPassword123", "", "SHA-384")
// returns { hash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z", salt: "random-uuid" }
export async function puff_hashing_password(
  pw: string,
  salt = "",
  algo = "SHA-384"
) {
  if (salt.length === 0) {
    salt = crypto.randomUUID()
  }

  const toHash = pw + salt
  const hash = await hashing_wrapper(toHash, algo)

  const hashes = {
    hash: hash,
    salt: salt,
    algo: algo,
  }
  return hashes
}

export async function puff_hashing_sha1_hibp(pw: string) {
  const pw_sha1 = await hashing_wrapper(pw, "SHA-1")

  const pw_sha1_f5 = pw_sha1.slice(0, 5)
  const pw_sha1_l35 = pw_sha1.slice(5, 40)

  const slices = {
    f5: pw_sha1_f5,
    l35: pw_sha1_l35,
  }
  return slices
}
