import { puff_hashing_password } from "./utilities_hashing.js"

export async function user_register(context, name, email, password) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    throw new Error(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration."
    )
  }
  const { Client } = require("pg") // Add pg client import
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    await client.connect()
    // Step 0. Prep work
    const emailExists = await user_exists(context, email) // This will use the updated user_exists
    if (emailExists) {
      // It's better to return a Response object or specific error message that the API endpoint can handle
      // For now, keeping the throw, but this might need adjustment based on how API endpoints handle errors.
      throw new Error("Email is already registered.")
    }

    // Step 1. Register the user
    const uuid = crypto.randomUUID() // Assuming crypto.randomUUID() is available
    await client.query(
      "INSERT INTO users (user_uuid, user_name) VALUES ($1, $2)",
      [uuid, name]
    )

    // Step 2. Register the email
    // Set is_primary = TRUE for the initial email, is_verified defaults to FALSE
    await client.query(
      "INSERT INTO emails (user_uuid, email_address, is_primary) VALUES ($1, $2, TRUE)",
      [uuid, email]
    )

    // Step 3. Register the password
    const now = new Date().toISOString() // Simplified date creation
    const { hash, salt } = await puff_hashing_password(password)
    const secret_value = hash + ":" + salt
    await client.query(
      "INSERT INTO secrets (user_uuid, secret_type, secret_value, secret_created_at) VALUES ($1, 'puff_password_sha-384', $2, $3)",
      [uuid, secret_value, now]
    )

    // Step 4. Generate and store email verification token
    const token_value = crypto.randomUUID()
    const token_expires_at = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString() // 24 hours from now

    await client.query(
      "INSERT INTO tokens (user_uuid, email_address, token_type, token_value, expires_at) VALUES ($1, $2, 'email_verification', $3, $4)",
      [uuid, email, token_value, token_expires_at]
    )

    // Log the verification link
    console.log(`Verification link: /api/verify_email?token=${token_value}`)

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
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    throw new Error(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration."
    )
  }
  const { Client } = require("pg")
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
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    throw new Error(
      "Hyperdrive binding [HYPERDRIVE] not found. Please check Pages Function configuration."
    )
  }
  const { Client } = require("pg")
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
  const { password_verify } = await import("./passwords.js") // Dynamic import
  const { Client } = require("pg") // Add pg client import
  const pgClient = new Client(context.env.HYPERDRIVE.connectionString) // Use a different variable name to avoid conflict

  try {
    await pgClient.connect()
    const user = await getUserByEmail(context, email) // getUserByEmail already uses pg

    if (!user) {
      return new Response("Invalid email or password.", { status: 401 })
    }

    // Check if email is verified
    if (!user.is_verified) {
      return new Response("Please verify your email before logging in.", {
        status: 403,
      })
    }

    // Pass 'context' as the first argument. password_verify will need migration too.
    const passwordMatches = await password_verify(
      context, // password_verify will need access to the DB via context or a direct client
      password,
      user.user_uuid
    )

    if (passwordMatches) {
      // Check if 2FA is enabled for the user by querying the 'secrets' table
      const twoFactorRecordResult = await pgClient.query(
        "SELECT secret_enabled FROM secrets WHERE user_uuid = $1 AND secret_type = 'totp_secret' AND secret_enabled = TRUE",
        [user.user_uuid]
      )
      const twoFactorRecord = twoFactorRecordResult.rows[0]

      if (twoFactorRecord) {
        // If a record is found, it means secret_enabled was TRUE
        // 2FA is enabled, respond that TOTP is required
        return new Response(
          `Please provide your TOTP code for user "${user.user_uuid}".`,
          { status: 200 } // Status 200 as it's an expected intermediate step
        )
      } else {
        // 2FA is not enabled, proceed with direct session creation
        const session_id = crypto.randomUUID()
        const expires_at = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString() // 7 days from now
        const user_agent = context.request.headers.get("User-Agent") || ""
        const ip_address = context.request.headers.get("CF-Connecting-IP") || ""

        await pgClient.query(
          "INSERT INTO sessions (session_id, user_uuid, expires_at, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5)",
          [session_id, user.user_uuid, expires_at, user_agent, ip_address]
        )

        return new Response(`session_token: "${session_id}"`, { status: 200 })
      }
    } else {
      return new Response("Invalid email or password.", { status: 401 })
    }
  } catch (dbError) {
    console.error("Error during user login:", dbError)
    return new Response("Login failed due to a server error.", { status: 500 })
  } finally {
    await pgClient.end()
  }
}
