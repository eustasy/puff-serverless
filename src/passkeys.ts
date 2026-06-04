import { isoBase64URL } from "@simplewebauthn/server/helpers"

/** Returns all enabled passkeys for the user, ordered by creation date. */
export async function listPasskeys(dbClient: DbClient, user_uuid: string): Promise<Envelope<{ passkeys: PasskeyRow[] }>> {
  try {
    const result = await dbClient.query(
      "SELECT passkey_uuid, user_uuid, credential_id, public_key, counter, transports, passkey_name, created_at, last_used_at, is_enabled FROM passkeys WHERE user_uuid = $1 AND is_enabled = TRUE ORDER BY created_at ASC",
      [user_uuid]
    )
    return { success: true, passkeys: result.rows, status: 200 }
  } catch (error) {
    console.error("Error in listPasskeys:", error)
    return {
      error: true,
      message: "Could not list passkeys.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Looks up an enabled passkey by its WebAuthn credential_id; used during authentication to find the public key. */
export async function getPasskeyByCredentialId(dbClient: DbClient, credentialId: string): Promise<Envelope<{ passkey: PasskeyRow }>> {
  try {
    const result = await dbClient.query(
      "SELECT passkey_uuid, user_uuid, credential_id, public_key, counter, transports, passkey_name, created_at, last_used_at, is_enabled FROM passkeys WHERE credential_id = $1 AND is_enabled = TRUE LIMIT 1",
      [credentialId]
    )
    if (result.rows.length > 0) {
      return { success: true, passkey: result.rows[0], status: 200 }
    }
    return { success: false, message: "Passkey not found.", status: 404 }
  } catch (error) {
    console.error("Error in getPasskeyByCredentialId:", error)
    return {
      error: true,
      message: "Could not look up passkey.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Inserts a new passkey row after a successful WebAuthn registration; stores the public key as base64url. */
export async function savePasskey(
  dbClient: DbClient,
  user_uuid: string,
  credentialId: string,
  publicKeyBytes: Uint8Array,
  counter: number,
  transports: string[] | undefined,
  name: string
): Promise<Envelope> {
  try {
    const passkey_uuid = crypto.randomUUID()
    const publicKey = isoBase64URL.fromBuffer(publicKeyBytes as Uint8Array<ArrayBuffer>)
    await dbClient.query(
      "INSERT INTO passkeys (passkey_uuid, user_uuid, credential_id, public_key, counter, transports, passkey_name) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [passkey_uuid, user_uuid, credentialId, publicKey, counter, transports ?? null, name]
    )
    return { success: true, status: 201 }
  } catch (error) {
    console.error("Error in savePasskey:", error)
    return {
      error: true,
      message: "Could not save passkey.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Updates the signature counter and last_used_at after a successful WebAuthn assertion; guards against cloned authenticators. */
export async function updatePasskeyCounter(dbClient: DbClient, passkey_uuid: string, counter: number): Promise<Envelope> {
  try {
    await dbClient.query("UPDATE passkeys SET counter = $1, last_used_at = NOW() WHERE passkey_uuid = $2", [counter, passkey_uuid])
    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in updatePasskeyCounter:", error)
    return {
      error: true,
      message: "Could not update passkey counter.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Hard-deletes a passkey row; scoped by user_uuid so users cannot delete each other's passkeys. */
export async function deletePasskey(dbClient: DbClient, passkey_uuid: string, user_uuid: string): Promise<Envelope> {
  try {
    const result = await dbClient.query("DELETE FROM passkeys WHERE passkey_uuid = $1 AND user_uuid = $2 RETURNING passkey_uuid", [
      passkey_uuid,
      user_uuid,
    ])
    if ((result.rowCount ?? 0) > 0) {
      return { success: true, status: 200 }
    }
    return { success: false, message: "Passkey not found.", status: 404 }
  } catch (error) {
    console.error("Error in deletePasskey:", error)
    return {
      error: true,
      message: "Could not delete passkey.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/** Derives the WebAuthn RP ID and name from env vars, falling back to hostname from APP_URL then "localhost". */
export function getRpConfig(env: Env): { rpID: string; rpName: string } {
  let rpID: string
  if (env.WEBAUTHN_RP_ID) {
    rpID = env.WEBAUTHN_RP_ID
  } else if (env.APP_URL) {
    try {
      rpID = new URL(env.APP_URL).hostname
    } catch {
      rpID = "localhost"
    }
  } else {
    rpID = "localhost"
  }
  const rpName = env.WEBAUTHN_RP_NAME || env.APP_NAME || "puff"
  return { rpID, rpName }
}
