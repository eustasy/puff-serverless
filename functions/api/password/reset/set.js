import {
  password_requirements,
  password_requirements_html,
  updatePassword, // Import updatePassword
} from "../../../../src/passwords.js"
import { readToken, updateToken } from "../../../../src/tokens.js"

export async function onRequestPost(context) {
  let requestBody
  try {
    requestBody = await context.request.json()
  } catch (e) {
    return new Response('<p class="error">Invalid JSON body.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  const { token, new_password } = requestBody

  if (!token || typeof token !== "string") {
    return new Response(
      '<p class="error">Reset token is missing or invalid.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
  if (!new_password || typeof new_password !== "string") {
    return new Response(
      '<p class="error">New password is missing or invalid.</p>',
      {
        status: 400,
        headers: { "Content-Type": "text/html" },
      }
    )
  }

  try {
    const passwordCheckResult = await password_requirements(new_password) // Await the promise
    if (!passwordCheckResult) {
      // password_requirements returns boolean
      const requirementsHTML = await password_requirements_html(new_password) // Await the promise
      return new Response(requirementsHTML, {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    const tokenReadResult = await readToken(context, token, ["password_reset"])

    if (!tokenReadResult.success || !tokenReadResult.token) {
      return new Response(
        '<p class="error">Invalid or expired password reset token.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const tokenRecord = tokenReadResult.token

    if (tokenRecord.is_used === true) {
      return new Response(
        '<p class="error">Password reset token has already been used.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const now = new Date()
    const tokenExpiresAt = new Date(tokenRecord.expires_at)
    if (now > tokenExpiresAt) {
      await updateToken(context, token, "password_reset", { is_used: true })
      return new Response(
        '<p class="error">Password reset token has expired.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const user_uuid = tokenRecord.user_uuid

    const passwordUpdated = await updatePassword(
      context,
      user_uuid,
      new_password
    )

    if (!passwordUpdated) {
      return new Response(
        '<p class="error">Failed to update password. Password record issue or no change detected.</p>',
        {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    await updateToken(context, token, "password_reset", { is_used: true })

    // Redirect to login page on successful password reset
    return new Response(null, {
      status: 303, // See Other
      headers: {
        "HX-Redirect":
          "/login.html?message=Password has been reset successfully.",
      },
    })
  } catch (error) {
    console.error("Error during password reset:", error)
    return new Response(
      '<p class="error">Failed to reset password due to a server error.</p>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      }
    )
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context)
  }
  return new Response('<p class="error">Method Not Allowed</p>', {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "text/html" },
  })
}
