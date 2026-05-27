// Base64url codec — the URL-safe, padding-less base64 variant used by
// JWT/JWS/JWA, PKCE, and cookie payloads. Three pairs, each preferred for the
// underlying value: raw bytes, UTF-8 strings, or JSON-serialisable objects.
//
// All decoders throw on malformed input — there is no out-of-band null
// sentinel, since `atob` and `JSON.parse` already report bad inputs as
// exceptions and forcing every caller through `try/catch` makes the failure
// mode explicit.

/** Encode bytes as base64url (no padding). */
export function encodeBytes(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decode base64url to bytes. Throws on malformed input. */
export function decodeBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Encode a binary-safe string (Latin-1 codepoints) as base64url. */
export function encodeString(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decode base64url to a binary-safe string. Throws on malformed input. */
export function decodeString(input: string): string {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4)
  return atob(padded)
}

/** Encode a JSON-serialisable value as base64url-encoded UTF-8 JSON. */
export function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)))
}

/** Decode base64url-encoded UTF-8 JSON. Throws if base64 or JSON is malformed. */
export function decodeJson<T = unknown>(input: string): T {
  const bytes = decodeBytes(input)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
