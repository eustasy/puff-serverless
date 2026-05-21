// Short-lived tokens carrying a verified federated identity from the
// /login/[provider]/callback endpoint to the signup-confirmation page. Each
// row holds the provider data we collected at callback time so the user can
// confirm their account creation without re-running the OAuth round-trip.
//
// These are pre-user — there is no `user_uuid` yet — so they cannot live in
// the generic `tokens` table (its `user_uuid` is NOT NULL FK). Hence the
// dedicated `federated_signup_tokens` table.

// 15-minute TTL — long enough for a user to confirm, short enough that an
// abandoned signup expires quickly.
export const FEDERATED_SIGNUP_TOKEN_TTL_SECONDS = 15 * 60

interface CreateInput {
  provider: string
  provider_user_id: string
  email: string | null
  email_verified: boolean
  display_name: string | null
}

/** Issues a fresh signup token carrying the provider data. */
export async function createFederatedSignupToken(
  dbClient: DbClient,
  input: CreateInput
): Promise<Envelope<{ token: string }>> {
  try {
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "")
    await dbClient.query(
      `INSERT INTO federated_signup_tokens
          (token_value, provider, provider_user_id, email, email_verified, display_name, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6,
                NOW() + ($7::INT) * INTERVAL '1 second')`,
      [
        token,
        input.provider,
        input.provider_user_id,
        input.email,
        input.email_verified,
        input.display_name,
        FEDERATED_SIGNUP_TOKEN_TTL_SECONDS,
      ]
    )
    return { success: true, token, status: 200 }
  } catch (error) {
    console.error("Error in createFederatedSignupToken:", error)
    return {
      error: true,
      message: "Could not start signup.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Read-only lookup — does not consume. Used by the signup confirmation page
 * to preview the proposed account. Consume happens in the POST handler.
 */
export async function readFederatedSignupToken(
  dbClient: DbClient,
  token: string
): Promise<Envelope<{ row: FederatedSignupTokenRow }>> {
  try {
    const { rows } = await dbClient.query(
      `SELECT token_value, provider, provider_user_id, email, email_verified, display_name, expires_at, created_at, is_used
         FROM federated_signup_tokens
        WHERE token_value = $1 AND is_used = FALSE AND expires_at > NOW()
        LIMIT 1`,
      [token]
    )
    if (rows.length === 0) {
      return {
        success: false,
        message: "Signup link is invalid or has expired.",
        status: 400,
      }
    }
    return { success: true, row: rows[0], status: 200 }
  } catch (error) {
    console.error("Error in readFederatedSignupToken:", error)
    return {
      error: true,
      message: "Could not read signup link.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Atomic single-use consume (mirrors `consumeToken` in src/tokens.ts). The
 * UPDATE collapses used / expired / missing into a single negative envelope.
 */
export async function consumeFederatedSignupToken(
  dbClient: DbClient,
  token: string
): Promise<Envelope<{ row: FederatedSignupTokenRow }>> {
  try {
    const { rows } = await dbClient.query(
      `UPDATE federated_signup_tokens
          SET is_used = TRUE
        WHERE token_value = $1 AND is_used = FALSE AND expires_at > NOW()
        RETURNING *`,
      [token]
    )
    if (rows.length === 0) {
      return {
        success: false,
        message: "Signup link is invalid or has expired.",
        status: 400,
      }
    }
    return { success: true, row: rows[0], status: 200 }
  } catch (error) {
    console.error("Error in consumeFederatedSignupToken:", error)
    return {
      error: true,
      message: "Could not consume signup link.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
