const { Client } = require("pg") // Add pg client
const SECRET_TYPE = "totp_secret"

export async function create2fa(
  context, // Changed client to context
  user_uuid,
  secret_value,
  secret_name = null
) {
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_name, secret_created_at, is_enabled)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, FALSE) // Set is_enabled to FALSE by default
    ON CONFLICT (user_uuid, secret_type) DO UPDATE
    SET secret_value = EXCLUDED.secret_value, 
        secret_name = EXCLUDED.secret_name, 
        secret_created_at = CURRENT_TIMESTAMP, -- Reset created_at on update for clarity
        is_enabled = FALSE -- Ensure it's marked as not enabled until verified
    RETURNING *;
  `
  const values = [user_uuid, SECRET_TYPE, secret_value, secret_name]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
    return rows && rows.length > 0 ? rows[0] : null
  } catch (error) {
    console.error("Error creating/updating 2FA secret:", error)
    // Return a more structured error
    return { error: "Could not create or update 2FA secret.", status: 500 }
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

export async function read2fa(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    SELECT user_uuid, secret_type, secret_value, secret_name, is_enabled, secret_created_at, secret_last_used
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2;
  `
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
    return rows && rows.length > 0 ? rows[0] : null
  } catch (error) {
    console.error("Error reading 2FA secret:", error)
    // Return a more structured error
    return { error: "Could not read 2FA secret.", status: 500 }
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

export async function delete2fa(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    DELETE FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *; 
  `
  // RETURNING * is useful to confirm deletion, but for a simple success/fail, rowCount is enough.
  // For consistency with other similar functions, let's return an object indicating success/failure.
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const result = await client.query(query, values)
    // Return rowCount for confirmation
    return { rowCount: result.rowCount, status: 200 }
  } catch (error) {
    console.error("Error deleting 2FA secret:", error)
    return { error: "Could not delete 2FA secret.", status: 500 }
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

export async function has2fa(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    SELECT 1
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE;
  `
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
    return rows && rows.length > 0 // Returns true if enabled 2FA exists, false otherwise
  } catch (error) {
    console.error("Error checking 2FA secret:", error)
    // To be consistent with other functions, return an error object or throw
    // For a boolean check, perhaps returning false on error is acceptable if the caller handles it.
    // However, to signal a DB issue vs. "no 2FA", an error object is better.
    return { error: "Could not check 2FA status.", status: 500 }
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

export async function enable2fa(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    UPDATE secrets
    SET is_enabled = TRUE, secret_last_used = NULL -- Reset last_used upon enabling
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *; 
  `
  // RETURNING * to get the updated record.
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
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
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

// disable2fa is not directly used by the remove flow but good to update for consistency
export async function disable2fa(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    UPDATE secrets
    SET is_enabled = FALSE
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
    if (rows && rows.length > 0) {
      return { success: true, record: rows[0], status: 200 }
    } else {
      return {
        success: false,
        error: "2FA secret not found or could not be disabled.",
        status: 404,
      }
    }
  } catch (error) {
    console.error("Error disabling 2FA secret:", error)
    return { error: "Could not disable 2FA secret.", status: 500 }
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}

export async function update2faLastUsed(context, user_uuid) {
  // Changed client to context
  const client = new Client(context.env.HYPERDRIVE.connectionString) // Create client
  const query = `
    UPDATE secrets
    SET secret_last_used = CURRENT_TIMESTAMP
    WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE
    RETURNING *;
  `
  // Only update if 2FA is enabled.
  const values = [user_uuid, SECRET_TYPE]
  try {
    await client.connect() // Connect client
    const { rows } = await client.query(query, values)
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
  } finally {
    if (client) {
      await client.end() // Close client
    }
  }
}
