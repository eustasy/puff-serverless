import {
	puff_hashing_password,
	puff_hashing_sha1_hibp,
} from "../../src/utilities_hashing.js"

export async function onRequest(context) {
	const pw = "B4c0//"
	const sha384 = await puff_hashing_password(pw)
	const sha1 = await puff_hashing_sha1_hibp(pw)

	const hashes = {
		sha384,
		sha1,
	}
	return Response.json(hashes)
}
