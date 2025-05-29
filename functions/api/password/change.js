import { verifySession } from "../../src/session_auth.js" // verifySession is now pg-ready
import {
  password_check, // Remains non-DB
  // password_requirements_html, // Remains non-DB
  password_verify, // Is now pg-ready
} from "../../src/passwords.js"
import { puff_hashing_password } from "../../src/utilities_hashing.js" // Remains non-DB

export async function onRequestPost(context) {
  // Validate context and HYPERDRIVE binding
  if (!context || !context.env || !context.env.HYPERDRIVE) {
    console.error(
      "Hyperdrive binding [HYPERDRIVE] not found in change_password. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
  const { Client } = require("pg")
  const client = new Client(context.env.HYPERDRIVE.connectionString)

  // Step 1: Session Verification
  // verifySession itself will use the pg client if it needs to connect to DB.
  const sessionVerificationResult = await verifySession(context)
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult // Session invalid or error occurred
  }
  // If true, context.data.user_uuid is populated
  const user_uuid = context.data.user_uuid

  // Step 2: Parse JSON body
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const { current_password, new_password } = requestBody

  // Step 3: Input Validation (remains the same)
  if (!current_password || typeof current_password !== "string") {
    return new Response(
      JSON.stringify({ error: "Current password is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      JSON.stringify({ error: "New password is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    await client.connect()
    // Step 4: Password Strength Check (New Password) - password_check is non-DB
    // The password_check function in the provided snippet seems to return a boolean directly,
    // not an object with a .strong property. Assuming it should be:
    const isPasswordStrong = await password_check(new_password) // Assuming password_check is async due to HIBP potentially
    if (!isPasswordStrong) {
      // Adjusted based on typical boolean return for a check
      return new Response(
        JSON.stringify({
          error: "New password does not meet requirements.",
          // requirements_html: await password_requirements_html(new_password) // If you want to include this
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 5: Verify Current Password - password_verify is now pg-ready
    // password_verify will handle its own DB connection if called standalone,
    // but since we already have a client, it might be better to pass it if refactored.
    // For now, it will create its own connection as per its current migrated state.
    const currentPasswordMatches = await password_verify(
      context, // password_verify uses context to get HYPERDRIVE
      current_password,
      user_uuid
    )

    if (!currentPasswordMatches) {
      return new Response(
        JSON.stringify({ error: "Incorrect current password." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 6: Update Password
    const { hash: newHash, salt: newSalt } =
      await puff_hashing_password(new_password) // non-DB
    const new_secret_value = newHash + ":" + newSalt
    const secret_updated_at = new Date().toISOString()

    const updatePasswordResult = await client.query(
      "UPDATE secrets SET secret_value = $1, secret_created_at = $2 WHERE user_uuid = $3 AND secret_type = 'puff_password_sha-384'",
      [new_secret_value, secret_updated_at, user_uuid]
    )

    if (updatePasswordResult.rowCount === 0) {
      console.error(
        `Failed to update password for user_uuid (no rows changed): ${user_uuid}`
      )
      return new Response(
        JSON.stringify({
          error: "Failed to update password. Please try again.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 7: Response
    return new Response(
      JSON.stringify({ message: "Password changed successfully." }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("Error during password change:", error)
    return new Response(
      JSON.stringify({
        error: "Failed to change password due to a server error.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  } finally {
    await client.end()
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context)
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  })
}
