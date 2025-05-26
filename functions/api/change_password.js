import { verifySession } from "../../src/session_auth.js" // Adjust path as needed
import {
  password_check,
  password_requirements_html,
  password_verify,
} from "../../src/passwords.js" // Adjust path as needed
import { puff_hashing_password } from "../../src/utilities_hashing.js" // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in change_password. Check Pages Function configuration."
    )
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  // Step 1: Session Verification
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

  // Step 3: Input Validation
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
    // Step 4: Password Strength Check (New Password)
    const passwordCheckResult = password_check(new_password)
    if (!passwordCheckResult.strong) {
      return new Response(
        JSON.stringify({
          error: "New password does not meet requirements.",
          // Optionally include details:
          // requirements_html: password_requirements_html(),
          // details: passwordCheckResult.error,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    // Step 5: Verify Current Password
    // Fetch current hashed password and salt
    const secretRecord = await context.env.DATABASE.prepare(
      "SELECT secret_value FROM secrets WHERE user_uuid = ?1 AND secret_type = 'puff_password_sha-384' LIMIT 1"
    )
      .bind(user_uuid)
      .first()

    if (!secretRecord || !secretRecord.secret_value) {
      // This should not happen for an authenticated user, implies data inconsistency
      console.error(`Password secret not found for user_uuid: ${user_uuid}`)
      return new Response(
        JSON.stringify({
          error: "Could not verify current password. User record issue.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const [hashedPassword, salt] = secretRecord.secret_value.split(":")
    if (!hashedPassword || !salt) {
      console.error(`Invalid secret_value format for user_uuid: ${user_uuid}`)
      return new Response(
        JSON.stringify({
          error: "Could not verify current password. User record issue.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const currentPasswordMatches = await password_verify(
      context,
      current_password,
      user_uuid
    )

    if (!currentPasswordMatches) {
      return new Response(
        JSON.stringify({ error: "Incorrect current password." }),
        { status: 403, headers: { "Content-Type": "application/json" } } // 403 Forbidden or 401 Unauthorized
      )
    }

    // Step 6: Update Password
    const { hash: newHash, salt: newSalt } =
      await puff_hashing_password(new_password)
    const new_secret_value = newHash + ":" + newSalt
    const secret_updated_at = new Date().toISOString()

    const updatePasswordStmt = await context.env.DATABASE.prepare(
      "UPDATE secrets SET secret_value = ?1, secret_created_at = ?2 WHERE user_uuid = ?3 AND secret_type = 'puff_password_sha-384'"
    )
      .bind(new_secret_value, secret_updated_at, user_uuid)
      .run()

    if (updatePasswordStmt.meta.changes === 0) {
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
    // Security Note: Consider invalidating other active sessions for the user here. (Out of scope for this task)
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
  }
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Allow": "POST", "Content-Type": "application/json" },
    })
  }
  // For POST requests, Cloudflare Pages will automatically route to onRequestPost.
}
