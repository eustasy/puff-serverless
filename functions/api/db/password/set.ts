import {
  password_requirements,
  updatePassword,
} from "../../../../src/passwords.js"
import { readToken, usedToken } from "../../../../src/tokens.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  let formData
  let token
  let new_password
  try {
    formData = await context.request.formData()
    token = formData.get("token")
    new_password = formData.get("pw")
  } catch (e) {
    return new Response(
      '<p class="result-negative">Invalid request data.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  if (!token || typeof token !== "string") {
    return new Response(
      '<p class="result-negative">Reset token is missing or invalid.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      '<p class="result-negative">New password is missing or invalid.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const passwordCheckResult = password_requirements(new_password)
    if (!passwordCheckResult) {
      return new Response(
        '<p class="result-negative">New password does not meet requirements.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const tokenReadResult = await readToken(dbClient, token)

    if (!tokenReadResult.success || !tokenReadResult.token) {
      return new Response(
        '<p class="result-negative">Invalid or expired password reset token.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const tokenRecord = tokenReadResult.token

    if (tokenRecord.is_used === true) {
      return new Response(
        '<p class="result-negative">Password reset token has already been used.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)
    if (now > tokenExpiresAt) {
      await usedToken(dbClient, token)
      return new Response(
        '<p class="result-negative">Password reset token has expired.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const user_uuid = tokenRecord.user_uuid

    const updateResult = await updatePassword(dbClient, user_uuid, new_password)

    if (updateResult.error || !updateResult.success) {
      return new Response(
        `<p class="result-negative">${updateResult.message || "Failed to update password."}</p>`,
        {
          status: updateResult.status || 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    await usedToken(dbClient, token)

    // Redirect to login page on successful password reset
    return new Response(null, {
      status: 303,
      headers: {
        "HX-Redirect": "/login?code=password_reset_success",
      },
    })
  } catch (error) {
    console.error("Error during password reset:", error)
    return new Response(
      '<p class="result-negative">Failed to reset password due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
