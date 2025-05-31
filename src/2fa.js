const SECRET_TYPE = "totp_secret";

export async function create2fa(client, user_uuid, secret_value, secret_name = null) {
  const query = `
    INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_name, secret_created_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    RETURNING *;
  `;
  const values = [user_uuid, SECRET_TYPE, secret_value, secret_name];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error creating 2FA secret:', error);
    throw new Error('Could not create 2FA secret.');
  }
}

export async function read2fa(client, user_uuid) {
  const query = `
    SELECT user_uuid, secret_type, secret_value, secret_name, is_enabled, secret_created_at, secret_last_used
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error reading 2FA secret:', error);
    throw new Error('Could not read 2FA secret.');
  }
}

export async function delete2fa(client, user_uuid) {
  const query = `
    DELETE FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null; // Returns the deleted record
  } catch (error) {
    console.error('Error deleting 2FA secret:', error);
    throw new Error('Could not delete 2FA secret.');
  }
}

export async function has2fa(client, user_uuid) {
  const query = `
    SELECT 1
    FROM secrets
    WHERE user_uuid = $1 AND secret_type = $2 AND is_enabled = TRUE;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0;
  } catch (error) {
    console.error('Error checking 2FA secret:', error);
    throw new Error('Could not check 2FA secret.');
  }
}

export async function enable2fa(client, user_uuid) {
  const query = `
    UPDATE secrets
    SET is_enabled = TRUE
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error enabling 2FA secret:', error);
    throw new Error('Could not enable 2FA secret.');
  }
}

export async function disable2fa(client, user_uuid) {
  const query = `
    UPDATE secrets
    SET is_enabled = FALSE
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error disabling 2FA secret:', error);
    throw new Error('Could not disable 2FA secret.');
  }
}

export async function update2faLastUsed(client, user_uuid) {
  const query = `
    UPDATE secrets
    SET secret_last_used = CURRENT_TIMESTAMP
    WHERE user_uuid = $1 AND secret_type = $2
    RETURNING *;
  `;
  const values = [user_uuid, SECRET_TYPE];
  try {
    const { rows } = await client.query(query, values);
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error updating 2FA last used timestamp:', error);
    throw new Error('Could not update 2FA last used timestamp.');
  }
}
