//const fromHexString = (hexString) =>
//  Uint8Array.from(hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
//const toHexString = (bytes) =>
//  bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
//console.log(toHexString(Uint8Array.from([0, 1, 2, 42, 100, 101, 102, 255])));
//console.log(fromHexString('0001022a646566ff'));
// source: https://stackoverflow.com/a/50868276

async function Uint8toHex(f) {
  return f.from(hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)))
}

async function HextoUint8(f) {
  return f.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '')
}

async function puff_hash(pw, algo) {
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest(
    { name: algo },
    myText
  )
  const bitsBack = new Uint8Array(myDigest)
  const hash = await Uint8toHex(bitsBack)
  return hash
}

// SHA-1, SHA-25, SHA-384, SHA-512, MD5
// source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms
export async function puff_hashing_password(pw, salt = '', algo = 'SHA-384') {
  if ( salt.length === 0 ) {
    var uuid = crypto.randomUUID()
  }

  const toHash = pw + ':' + uuid
  const hash = await puff_hash(toHash, algo)

  const hashes = {
    'hash': hash,
    'salt': uuid
  }
  return hashes
}

export async function puff_hashing_sha1_hibp(pw) {
  const pw_sha1 = await puff_hash(pw, 'SHA-1')

  const pw_sha1_f5 = pw_sha1.slice(0, 5)
  const pw_sha1_l35 = pw_sha1.slice(5, 40)

  const slices = {
    'f5': pw_sha1_f5,
    'l35': pw_sha1_l35
  }
  return slices
}
