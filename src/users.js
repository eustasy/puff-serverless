import { createSession } from "./sessions.js"
const { Client } = require("pg")
import { createEmail, existsEmail, readEmail } from "./emails.js";
import { createPassword, password_verify } from "./passwords.js";
import { has2fa } from "./2fa.js";

export async function user_register(context, name, email, password) {
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  try {
    // Step 0. Check if the email already exists using existsEmail
    const emailCheck = await existsEmail(context, email);
    if (emailCheck.error) {
      console.error("Error checking email existence:", emailCheck.message);
      throw new Error("Failed to verify email existence during registration.");
    }
    if (emailCheck.exists) {
      throw new Error("Email is already registered.")
    }

    await client.connect()

    // Step 1. Register the user
    const uuid = crypto.randomUUID()
    await client.query(
      "INSERT INTO users (user_uuid, user_name) VALUES ($1, $2)",
      [uuid, name]
    )

    // Step 2. Register the email using createEmail function
    // createEmail will handle token generation internally
    const createEmailResult = await createEmail(context, uuid, email, true, false) // true for is_primary, false for is_verified initially
    if (createEmailResult.error) {
      // If createEmail itself had an issue (e.g. unique constraint within its own logic if user already had it - though less likely here)
      // This part might need more robust error handling depending on how createEmail signals errors.
      // For now, re-throwing a generic error or createEmailResult.message
      throw new Error(
        createEmailResult.message ||
          "Failed to add primary email during registration."
      )
    }
    // Log the verification link using the token from createEmailResult
    if (createEmailResult.token_value) {
      console.log(
        `Verification link: /api/email/verify?token=${createEmailResult.token_value}`
      )
    }

    // Step 3. Register the password using createPassword
    const passwordCreated = await createPassword(context, uuid, password);
    if (!passwordCreated) {
      // This case implies an issue within createPassword, like a DB error it couldn't handle.
      // createPassword itself throws an error on failure, so this might be redundant if not caught and returned as false.
      // However, if createPassword is modified to return false on specific logical failures (not just DB exceptions), this check is useful.
      throw new Error("Failed to create password during registration.");
    }

    return { success: true, user_uuid: uuid, email: email }
  } catch (error) {
    console.error("Error during user registration:", error)
    // Propagate the error or return a structured error response
    throw error // Or return { error: true, message: error.message }
  } finally {
    // Ensure client is ended only if it was connected by this function
    if (client && client._connected) { // Check if client was connected
        await client.end()
    }
  }
}

export async function user_exists(context, email) {
  // const client = new Client(context.env.HYPERDRIVE.connectionString) // Handled by existsEmail

  try {
    // await client.connect() // Handled by existsEmail
    const emailCheck = await existsEmail(context, email);
    if (emailCheck.error) {
        console.error("Error in user_exists calling existsEmail:", emailCheck.message);
        // Decide on how to propagate this error. Throwing it might be consistent.
        throw new Error(emailCheck.message || "Failed to check if user exists.");
    }
    return emailCheck.exists ? 1 : 0; // Return 1 if exists, 0 if not, to match previous logic (parseInt on COUNT)
  } catch (error) {
    console.error("Error in user_exists:", error) // This will catch errors from existsEmail or here
    throw error
  }
}

export async function user_login(context, email, password) {
  let client
  try {
    // client instantiation and connection remains as it's used for TOTP and sessions.
    client = new Client(context.env.HYPERDRIVE.connectionString)
    await client.connect()

    const user = await readEmail(context, email)

    if (!user) {
      return { error: true, message: "Invalid email or password.", status: 401 }
    }

    if (!user.is_verified) {
      return {
        error: true,
        message: "Please verify your email before logging in.",
        status: 403,
      }
    }

    // Use password_verify from the imported passwords.js module
    const passwordMatches = await password_verify(
      context,
      password,
      user.user_uuid
    );

    if (!passwordMatches) {
      return { error: true, message: "Invalid email or password.", status: 401 }
    }

    const twoFactorEnabled = await has2fa(client, user.user_uuid);

    if (twoFactorEnabled) {
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

    const sessionDetails = await createSession(
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
    return {
      error: true,
      message: "Login failed due to a server error.",
      status: 500,
    }
  } finally {
    if (client) {
      await client.end()
    }
  }
}
