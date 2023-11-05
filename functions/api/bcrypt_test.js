import { bcrypt } from './../../src/bcrypt.js';

export async function onRequest(context) {
  var salt = bcrypt.genSaltSync(10)
  var hash = bcrypt.hashSync("B4c0/\/", salt)
  return Response.json(hash)
}
