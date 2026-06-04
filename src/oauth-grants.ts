// Domain module for the `oauth_grants` table — authorization codes and
// refresh tokens. Access tokens are signed JWTs and never stored here.
//
// Single-use semantics: every consume is an atomic UPDATE that flips
// `is_used = TRUE` only when the row was unused, unexpired, of the matching
// type, and (for codes) tied to the right app + redirect_uri. The collapsed
// "invalid grant" outcome — used / expired / wrong type / wrong client /
// missing — is a single negative envelope.

export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60 // 5 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

interface CreateAuthorizationCodeInput {
  user_uuid: string
  app_uuid: string
  /**
   * Org context the user picked at /authorize time. Null when no licensed
   * org applies (i.e. the app's licensing mode is `none` or the org context
   * wasn't supplied). The token endpoint propagates this onto refresh tokens
   * and the entitlements claim baked into the access token.
   */
  org_uuid: string | null
  scopes: string[]
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  nonce: string | null
}

/**
 * Issue a fresh authorization code for a user/app/scope tuple. Returns the
 * opaque code string; the caller hands it back to the client in the redirect.
 * `nonce` is the optional OIDC value to bake into the eventual ID token (only
 * meaningful when `openid` is among the scopes).
 */
export async function createAuthorizationCode(
  dbClient: DbClient,
  input: CreateAuthorizationCodeInput
): Promise<Envelope<{ code: string }>> {
  try {
    const code = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "")
    const query = `
      INSERT INTO oauth_grants (
        grant_value, grant_type, user_uuid, app_uuid, org_uuid, scopes,
        redirect_uri, code_challenge, code_challenge_method, nonce, expires_at
      )
      VALUES ($1, 'authorization_code', $2, $3, $4, $5, $6, $7, $8, $9,
              now() + ($10::INT) * INTERVAL '1 second')
      RETURNING grant_value
    `
    const values = [
      code,
      input.user_uuid,
      input.app_uuid,
      input.org_uuid,
      input.scopes,
      input.redirect_uri,
      input.code_challenge,
      input.code_challenge_method,
      input.nonce,
      AUTHORIZATION_CODE_TTL_SECONDS,
    ]
    const { rows } = await dbClient.query(query, values)
    if (rows.length === 0) {
      return {
        error: true,
        message: "Authorization code insert returned no row.",
        status: 500,
      }
    }
    return { success: true, code, status: 200 }
  } catch (error) {
    console.error("Error in createAuthorizationCode:", error)
    return {
      error: true,
      message: "Could not create authorization code.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Atomically consume an authorization code. Succeeds only when the code is
 * unused, unexpired, belongs to `app_uuid`, and matches `redirect_uri`
 * (RFC 6749 §4.1.3 — redirect_uri must match the one used during authorize).
 * On hit returns the full row so the caller can pull the PKCE challenge,
 * scopes, and user_uuid out for the token response.
 */
export async function consumeAuthorizationCode(
  dbClient: DbClient,
  code: string,
  app_uuid: string,
  redirect_uri: string
): Promise<Envelope<{ grant: OAuthGrantRow }>> {
  try {
    const query = `
      UPDATE oauth_grants
      SET is_used = TRUE
      WHERE grant_value = $1
        AND grant_type = 'authorization_code'
        AND app_uuid = $2
        AND redirect_uri = $3
        AND is_used = FALSE
        AND expires_at > now()
      RETURNING *
    `
    const { rows } = await dbClient.query(query, [code, app_uuid, redirect_uri])
    if (rows.length > 0) {
      return { success: true, grant: rows[0], status: 200 }
    }
    return {
      success: false,
      message: "Invalid authorization code.",
      status: 400,
    }
  } catch (error) {
    console.error("Error in consumeAuthorizationCode:", error)
    return {
      error: true,
      message: "Could not consume authorization code.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

interface CreateRefreshTokenInput {
  user_uuid: string
  app_uuid: string
  /** Org context propagated from the original authorization code. */
  org_uuid: string | null
  scopes: string[]
  parent_grant_value: string | null
}

/**
 * Issue a refresh token. On initial code exchange `parent_grant_value` is
 * null; on rotation it points at the previously-consumed refresh token so
 * reuse detection can walk the chain.
 */
export async function createRefreshToken(dbClient: DbClient, input: CreateRefreshTokenInput): Promise<Envelope<{ token: string }>> {
  try {
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "")
    const query = `
      INSERT INTO oauth_grants (
        grant_value, grant_type, user_uuid, app_uuid, org_uuid, scopes,
        parent_grant_value, expires_at
      )
      VALUES ($1, 'refresh_token', $2, $3, $4, $5, $6,
              now() + ($7::INT) * INTERVAL '1 second')
      RETURNING grant_value
    `
    const values = [
      token,
      input.user_uuid,
      input.app_uuid,
      input.org_uuid,
      input.scopes,
      input.parent_grant_value,
      REFRESH_TOKEN_TTL_SECONDS,
    ]
    const { rows } = await dbClient.query(query, values)
    if (rows.length === 0) {
      return {
        error: true,
        message: "Refresh token insert returned no row.",
        status: 500,
      }
    }
    return { success: true, token, status: 200 }
  } catch (error) {
    console.error("Error in createRefreshToken:", error)
    return {
      error: true,
      message: "Could not create refresh token.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Atomically consume a refresh token. Succeeds only when unused, unexpired,
 * and bound to `app_uuid`. The grant row is returned so the caller can mint
 * the new access token with the same scopes and link the rotation chain.
 */
export async function consumeRefreshToken(
  dbClient: DbClient,
  token: string,
  app_uuid: string
): Promise<Envelope<{ grant: OAuthGrantRow }>> {
  try {
    const query = `
      UPDATE oauth_grants
      SET is_used = TRUE
      WHERE grant_value = $1
        AND grant_type = 'refresh_token'
        AND app_uuid = $2
        AND is_used = FALSE
        AND expires_at > now()
      RETURNING *
    `
    const { rows } = await dbClient.query(query, [token, app_uuid])
    if (rows.length > 0) {
      return { success: true, grant: rows[0], status: 200 }
    }
    return { success: false, message: "Invalid refresh token.", status: 400 }
  } catch (error) {
    console.error("Error in consumeRefreshToken:", error)
    return {
      error: true,
      message: "Could not consume refresh token.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}

/**
 * Reuse-attack containment: when a refresh token is presented after it was
 * already consumed, RFC 6749 §10.4 / OAuth 2.1 §6.1 require invalidating
 * every other refresh token in the same rotation chain. This walks the
 * parent_grant_value graph forward and backward from `token` and flips each
 * to `is_used = TRUE`. Best-effort; failures are logged but don't change the
 * caller's response (the suspected reuse is already grounds for rejection).
 */
export async function revokeRefreshTokenChain(dbClient: DbClient, token: string): Promise<Envelope<{ revoked: number }>> {
  try {
    const query = `
      WITH RECURSIVE chain AS (
        SELECT grant_value, parent_grant_value
        FROM oauth_grants
        WHERE grant_value = $1
        UNION
        SELECT g.grant_value, g.parent_grant_value
        FROM oauth_grants g
        JOIN chain c
          ON g.parent_grant_value = c.grant_value OR g.grant_value = c.parent_grant_value
      )
      UPDATE oauth_grants
      SET is_used = TRUE
      WHERE grant_value IN (SELECT grant_value FROM chain)
        AND grant_type = 'refresh_token'
        AND is_used = FALSE
      RETURNING grant_value
    `
    const { rows } = await dbClient.query(query, [token])
    return { success: true, revoked: rows.length, status: 200 }
  } catch (error) {
    console.error("Error in revokeRefreshTokenChain:", error)
    return {
      error: true,
      message: "Could not revoke refresh-token chain.",
      details: error instanceof Error ? error.message : String(error),
      status: 500,
    }
  }
}
