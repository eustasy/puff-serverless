export async function onRequest(context) {
  const pw = "B4c0/\/"
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest(
    {
      name: 'SHA-384',
    },
    myText // The data you want to hash as an ArrayBuffer
  )
  const sha384 = new Uint8Array(myDigest))
  const myDigest2 = await crypto.subtle.digest(
    {
      name: 'SHA-1',
    },
    myText // The data you want to hash as an ArrayBuffer
  )
  const sha1 = new Uint8Array(myDigest2))
  let uuid = crypto.randomUUID()

  hashes = {
    'sha384': sha384,
    'sha1': sha1,
    'uuid': uuid
  }
  return Response.json(hashes)
}
