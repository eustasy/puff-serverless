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

// SHA-1, SHA-25, SHA-384, SHA-512, MD5
// source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#supported-algorithms
export async function puff_hashing(pw, salt = '', algo = 'SHA-384') {
  if ( salt.length === 0 ) {
    var uuid = crypto.randomUUID()
  }

  const toHash = pw + ':' + uuid
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest(
    { name: algo },
    myText
  )
  const bitsBack = new Uint8Array(myDigest)
  const hash = await Uint8toHex(bitsBack)

  const hashes = {
    'hash': hash,
    'salt': uuid
  }
  return 
}

