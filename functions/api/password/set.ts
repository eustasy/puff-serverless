import { passwordConfig, passwordRequirements, isPasswordReused, updatePassword } from "../../../src/passwords.js"
import { consumeToken, readToken } from "../../../src/tokens.js"
import { emitFromContext } from "../../../src/hooks/dispatch.js"
import { EVENTS } from "../../../src/hooks/events.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  let formData
  let token
  let new_password
  try {
    formData = await context.request.formData()
    token = formData.get("token")
    new_password = formData.get("pw")
  } catch {
    return new Response('<p class="result-negative">Invalid request data.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  if (!token || typeof token !== "string") {
    return new Response('<p class="result-negative">Reset token is missing or invalid.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response('<p class="result-negative">New password is missing or invalid.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  try {
    const passwordCheckResult = await passwordRequirements(new_password, passwordConfig(context.env))
    if (!passwordCheckResult) {
      return new Response('<p class="result-negative">New password does not meet requirements.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Validate the reset token WITHOUT consuming it first, so that a rejected
    // password (previously used) does not burn the token and force the user to
    // request a brand-new reset email. consumeToken below remains the atomic
    // single-use gate; this read only resolves the user for the reuse check.
    const tokenRead = await readToken(dbClient, token)
    const pending = tokenRead.success ? tokenRead.token : null
    if (!pending || pending.token_type !== "password_reset" || pending.is_used || new Date(pending.expires_at) < new Date()) {
      return new Response('<p class="result-negative">Invalid or expired password reset token.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Reject reuse of any current or previous password (issue #22). Done
    // before the token is consumed — see the comment above.
    const reuseResult = await isPasswordReused(dbClient, pending.user_uuid, new_password)
    if (reuseResult.error) {
      return new Response('<p class="result-negative">Could not check password history. Please try again.</p>', {
        status: 500,
        headers: { "Content-Type": "text/html" },
      })
    }
    if (reuseResult.reused) {
      return new Response('<p class="result-negative">You cannot reuse a previous password. Please choose a new one.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    // Atomically consume the reset token. consumeToken marks it used and
    // validates type/expiry/used in one statement; a missing, wrong-type,
    // expired, or already-used token all collapse into this single failure.
    // It is also the race-safe authority: if two requests pass the read-check
    // above concurrently, only one consumeToken UPDATE wins.
    const tokenResult = await consumeToken(dbClient, token, "password_reset")

    if (!tokenResult.success) {
      return new Response('<p class="result-negative">Invalid or expired password reset token.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    const user_uuid = tokenResult.token.user_uuid

    const updateResult = await updatePassword(dbClient, user_uuid, new_password)

    if (updateResult.error || !updateResult.success) {
      return new Response(`<p class="result-negative">${updateResult.message || "Failed to update password."}</p>`, {
        status: updateResult.status || 500,
        headers: { "Content-Type": "text/html" },
      })
    }

    await emitFromContext(context, {
      event_type: EVENTS.ACCOUNT_PASSWORD_RESET_COMPLETED,
      actor_user_uuid: user_uuid,
      target_user_uuid: user_uuid,
    })

    // The token was already consumed atomically above — no separate
    // mark-used step. A failure here burns the token (the user requests a
    // fresh reset), the deliberate tradeoff over leaving a replay window.
    return new Response(null, {
      status: 303,
      headers: {
        "HX-Redirect": "/login?code=password_reset_success",
      },
    })
  } catch (error) {
    console.error("Error during password reset:", error)
    return new Response('<p class="result-negative">Failed to reset password due to a server error.</p>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async (_context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
