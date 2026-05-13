const SECRET_TYPE = "totp_secret"

export async function create2fa(
  dbClient,
  user_uuid,
  secret_value,
  secret_name = null
) {
  const secret_uuid = crypto.randomUUID()
  const query = `
    INSERT INTO secrets (secret_uuid, user_uuid, secret_type, secret_value, secret_name, is_enabled)
    VALUES ($1, $2, $3, $4, $5, FALSE)
    RETURNING *;
  `
  const values = [
    secret_uuid,
    user_uuid,
    SECRET_TYPE,
    secret_value,
    secret_name,
  ]
  try {
    const { rows } = await dbClient.query(query, values)
    if (rows && rows.length > 0) {
      return { success: true, twoFactor: rows[0], status: 200 }
    }
    return {
      error: true,
      message: "2FA creation returned no rows.",
      status: 500,
    }
  } catch (error) {
    console.error("Error creating/updating 2FA secret:", error)
    return {
      error: true,
      message: "Could not create 2FA secret.",
      details: error.message,
      status: 500,
    }
  }
}

export async function read2fa(dbClient, user_uuid) {
  const query = `
    SELECT user_uuid, secret_type, secret_value, secret_name, is_enabled, secret_created_at, secret_last_used
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2;
  `
  const values = [user_uuid, SECRET_TYPE]
  try {
    const { rows } = await dbClient.query(query, values)
    if (rows && rows.length > 0) {
      return { success: true, twoFactor: rows[0], status: 200 }
    }
    return { success: false, message: "2FA not configured.", status: 404 }
  } catch (error) {
    console.error("Error reading 2FA secret:", error)
    return {
      error: true,
      message: "Could not read 2FA secret.",
      details: error.message,
      status: 500,
    }
  }
}

export async function delete2fa(dbClient, user_uuid) {
  const query = `
    DELETE FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *; 
  `
  // RETURNING * is useful to confirm deletion, but for a simple success/fail, rowCount is enough.
  // For consistency with other similar functions, let's return an object indicating success/failure.
  const values = [user_uuid, SECRET_TYPE]
  try {
    const result = await dbClient.query(query, values)
    // Return rowCount for confirmation
    return { rowCount: result.rowCount, status: 200 }
  } catch (error) {
    console.error("Error deleting 2FA secret:", error)
    return { error: "Could not delete 2FA secret.", status: 500 }
  }
}

export async function has2fa(dbClient, user_uuid) {
  const query = `
    SELECT 1
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE;
  `
  const values = [user_uuid, SECRET_TYPE]
  try {
    const { rows } = await dbClient.query(query, values)
    return {
      success: true,
      enabled: rows && rows.length > 0,
      status: 200,
    }
  } catch (error) {
    console.error("Error checking 2FA secret:", error)
    return {
      error: true,
      message: "Could not check 2FA status.",
      details: error.message,
      status: 500,
    }
  }
}

export async function enable2fa(dbClient, user_uuid) {
  const query = `
    UPDATE secrets
    SET is_enabled = TRUE
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `
  // RETURNING * to get the updated record.
  const values = [user_uuid, SECRET_TYPE]
  try {
    const { rows } = await dbClient.query(query, values)
    // Check if update was successful (a row was affected)
    if (rows && rows.length > 0) {
      return { success: true, record: rows[0], status: 200 }
    } else {
      // This means no record was found for the user_uuid and secret_type, or it was already enabled.
      // It's important to distinguish if the secret didn't exist vs. already enabled.
      // For now, assume if no rows returned, the secret might not exist to be enabled.
      return {
        success: false,
        error: "2FA secret not found or could not be enabled.",
        status: 404,
      }
    }
  } catch (error) {
    console.error("Error enabling 2FA secret:", error)
    return { error: "Could not enable 2FA secret.", status: 500 }
  }
}

export async function used2fa(dbClient, user_uuid) {
  const query = `
    UPDATE secrets
    SET secret_last_used = CURRENT_TIMESTAMP
    WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE
    RETURNING *;
  `
  // Only update if 2FA is enabled.
  const values = [user_uuid, SECRET_TYPE]
  try {
    const { rows } = await dbClient.query(query, values)
    if (rows && rows.length > 0) {
      return { success: true, record: rows[0], status: 200 }
    } else {
      // This could mean 2FA is not enabled, or the record doesn't exist.
      return {
        success: false,
        error: "Could not update 2FA last used: not found or not enabled.",
        status: 404,
      }
    }
  } catch (error) {
    console.error("Error updating 2FA last used timestamp:", error)
    return { error: "Could not update 2FA last used timestamp.", status: 500 }
  }
}
