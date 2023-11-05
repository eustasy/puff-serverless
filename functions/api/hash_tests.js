export async function onRequest(context) {
  const pw = "B4c0/\/"
  const myText = new TextEncoder().encode(pw)
  const myDigest = await crypto.subtle.digest(
    {
      name: 'SHA-384',
    },
    myText // The data you want to hash as an ArrayBuffer
  )
  const hash = new Uint8Array(myDigest))
  return Response.json(hash)
}
