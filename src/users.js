import { startSession } from "./sessions.js"
const { Client } = require("pg")

export async function user_register(context, name, email, password) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)
  const { addEmail } = require("./emails.js") // Import addEmail

  try {
    await client.connect()
    // Step 0. Prep work
    const emailExistsResult = await client.query(
      "SELECT email_address FROM emails WHERE email_address = $1 LIMIT 1",
      [email]
    )
    if (emailExistsResult.rowCount > 0) {
      throw new Error("Email is already registered.")
    }

    // Step 1. Register the user
    const uuid = crypto.randomUUID() // Assuming crypto.randomUUID() is available
    await client.query(
      "INSERT INTO users (user_uuid, user_name) VALUES ($1, $2)",
      [uuid, name]
    )

    // Step 2. Register the email using addEmail function
    // addEmail will handle token generation internally
    const addEmailResult = await addEmail(context, uuid, email, true, false) // true for is_primary, false for is_verified initially
    if (addEmailResult.error) {
      // If addEmail itself had an issue (e.g. unique constraint within its own logic if user already had it - though less likely here)
      // This part might need more robust error handling depending on how addEmail signals errors.
      // For now, re-throwing a generic error or addEmailResult.message
      throw new Error(
        addEmailResult.message ||
          "Failed to add primary email during registration."
      )
    }
    // Log the verification link using the token from addEmailResult
    if (addEmailResult.token_value) {
      console.log(
        `Verification link: /api/email/verify?token=${addEmailResult.token_value}`
      )
    }

    // Step 3. Register the password
    const now = new Date().toISOString()
    const { puff_hashing_password } = await import("./passwords.js")
    const { hash, salt } = await puff_hashing_password(password)
    const secret_value = hash + ":" + salt
    await client.query(
      "INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_created_at) VALUES ($1, 'puff_password_sha-384', $2, $3)",
      [uuid, secret_value, now]
    )

    // The D1 driver returns metadata about the insert, pg client.query for INSERT doesn't return the same structure by default.
    // If specific results (like lastID or changes) are needed, the queries might need to be adjusted (e.g., using RETURNING clause).
    // For now, returning a success indicator or the input data might be sufficient.
    return { success: true, user_uuid: uuid, email: email }
  } catch (error) {
    console.error("Error during user registration:", error)
    // Propagate the error or return a structured error response
    throw error // Or return { error: true, message: error.message }
  } finally {
    await client.end()
  }
}

export async function user_exists(context, email) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()
    const result = await client.query(
      "SELECT COUNT(*) AS total FROM emails WHERE email_address = $1 LIMIT 1",
      [email]
    )
    // pg returns count as a string, so parse it
    return parseInt(result.rows[0].total, 10)
  } catch (error) {
    console.error("Error in user_exists:", error)
    throw error // Propagate
  } finally {
    await client.end()
  }
}

export async function getUserByEmail(context, email) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()
    // Step 1: Fetch User and Email Data
    const emailRecordResult = await client.query(
      "SELECT user_uuid, is_verified FROM emails WHERE email_address = $1 LIMIT 1",
      [email]
    )
    const emailRecord = emailRecordResult.rows[0]

    if (!emailRecord || !emailRecord.user_uuid) {
      return null // User not found by email
    }

    const user_uuid = emailRecord.user_uuid

    // Step 2: Fetch Password Secret
    const secretRecordResult = await client.query(
      "SELECT secret_value FROM secrets WHERE user_uuid = $1 AND secret_type = 'puff_password_sha-384' LIMIT 1",
      [user_uuid]
    )
    const secretRecord = secretRecordResult.rows[0]

    if (!secretRecord || !secretRecord.secret_value) {
      return null // Password secret not found for user
    }

    // Step 3: Parse Secret and Return User Object
    const [hashedPassword, salt] = secretRecord.secret_value.split(":")

    if (!hashedPassword || !salt) {
      // Handle error: secret_value is not in the expected "hash:salt" format
      console.error("Invalid secret_value format for user_uuid:", user_uuid)
      return null
    }

    return {
      user_uuid: user_uuid,
      email: email, // The input email
      is_verified: emailRecord.is_verified, // Add is_verified status
      hashedPassword: hashedPassword,
      salt: salt,
    }
  } catch (error) {
    console.error("Error in getUserByEmail:", error)
    throw error // Propagate
  } finally {
    await client.end()
  }
}

export async function user_login(context, email, password) {
  const { password_verify } = await import("./passwords.js")
  let client

  try {
    client = new Client(context.env.HYPERDRIVE.connectionString)
    await client.connect()

    const user = await getUserByEmail(context, email)

    if (!user) {
      return { error: true, message: "Invalid email or password.", status: 401 }
    }

    if (!user.is_verified) {
      return { error: true, message: "Please verify your email before logging in.", status: 403 }
    }

    const passwordMatches = await password_verify(
      context,
      password,
      user.user_uuid
    )

    if (!passwordMatches) {
      return { error: true, message: "Invalid email or password.", status: 401 }
    }

    const twoFactorRecordResult = await client.query(
      "SELECT secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = 'totp_secret' AND secret_enabled = TRUE",
      [user.user_uuid]
    )
    const twoFactorRecord = twoFactorRecordResult.rows[0]

    if (twoFactorRecord) {
      return {
        next_step: "totp",
        user_uuid: user.user_uuid,
        totp_required: true,
        message: `Please provide your TOTP code for user \"${user.user_uuid}\".`,
        status: 200, 
      }
    }

    const user_agent = context.request.headers.get("User-Agent")
    const ip_address = context.request.headers.get("CF-Connecting-IP")

    const sessionDetails = await startSession(
      client,
      user.user_uuid,
      user_agent,
      ip_address
    )

    if (sessionDetails.error) {
      return {
        error: true,
        message: sessionDetails.message || "Session creation failed.",
        status: sessionDetails.status || 500,
      }
    }

    return {
      user_uuid: user.user_uuid,
      session_id: sessionDetails.session_id,
      expires_at: sessionDetails.expires_at,
      status: 200,
    }
  } catch (dbError) {
    console.error("Error during user login:", dbError)
    return { error: true, message: "Login failed due to a server error.", status: 500 }
  } finally {
    if (client) {
      await client.end()
    }
  }
}
