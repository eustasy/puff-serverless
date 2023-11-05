import { puff_hashing } from './../../src/utilities_hashing.js';

export async function onRequest(context) {
  const pw = "B4c0/\/"
  const sha384 = await puff_hashing_password(pw)
  const sha1 = await puff_hashing_sha1_hibp(pw)

  var hashes = {
    'sha384': sha384,
    'sha1': sha1,
  }
  return Response.json(hashes)
}
