// Email delivery via the Mailtrap REST API (https://mailtrap.io/).
//
// Uses the native `fetch` API rather than the `mailtrap` npm SDK: the SDK is
// Node-oriented, whereas a plain HTTPS POST bundles cleanly for Workers with no
// extra dependency. Configuration is read from the Worker env:
//   MAILTRAP_TOKEN        (required) — Mailtrap API token, kept as a secret.
//   MAILTRAP_SENDER       (required) — verified sender email address.
//   MAILTRAP_SENDER_NAME  (optional) — sender display name; defaults to APP_NAME or "PuffAuth".
//   MAILTRAP_API_URL      (optional) — endpoint override, e.g. a sandbox inbox URL.
//   APP_URL               (required) — absolute origin used to build email links.
//
// Send failures are logged and surfaced as error envelopes; callers decide
// whether a failure is fatal. There is no automatic retry — the verification
// and password-reset flows both expose a user-driven resend/re-request path.

import { verificationEmail, passwordResetEmail, twoFactorBypassEmail, organisationInvitationEmail } from "./email-templates.js"

const DEFAULT_API_URL = "https://send.api.mailtrap.io/api/send"
const SEND_TIMEOUT_MS = 10000

interface EmailMessage {
  to: string
  subject: string
  text: string
  html?: string
  category?: string
}

// Origin used to build absolute links in emails. Returns null (and logs) when
// APP_URL is unset, since relative links are unusable in an email client.
function appOrigin(env: Env): string | null {
  const origin = (env.APP_URL || "").replace(/\/+$/, "")
  if (!origin) {
    console.error("Error in mailer: APP_URL is not configured.")
    return null
  }
  return origin
}

/**
 * Sends a single email through Mailtrap.
 * @param {Env} env - The Worker environment bindings.
 * @param {EmailMessage} message - Recipient, subject and bodies.
 * @returns {Promise<Envelope>} `{ success: true, status: 200 }` on accept,
 *   `{ error: true, message, status }` when unconfigured (500) or the send fails (502).
 */
export async function sendEmail(env: Env, message: EmailMessage): Promise<Envelope> {
  const token = env.MAILTRAP_TOKEN
  const sender = env.MAILTRAP_SENDER
  if (!token || !sender) {
    console.error("Error in sendEmail: MAILTRAP_TOKEN or MAILTRAP_SENDER is not configured.")
    return {
      error: true,
      message: "Email delivery is not configured.",
      status: 500,
    }
  }

  const body = {
    from: {
      email: sender,
      name: env.MAILTRAP_SENDER_NAME || env.APP_NAME || "PuffAuth",
    },
    to: [{ email: message.to }],
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(message.category ? { category: message.category } : {}),
  }

  try {
    const response = await fetch(env.MAILTRAP_API_URL || DEFAULT_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      console.error(`Error in sendEmail: Mailtrap responded ${response.status}.`, detail)
      return {
        error: true,
        message: "Failed to send email.",
        details: `Mailtrap HTTP ${response.status}`,
        status: 502,
      }
    }

    return { success: true, status: 200 }
  } catch (error) {
    console.error("Error in sendEmail:", error)
    return {
      error: true,
      message: "Failed to send email.",
      details: error instanceof Error ? error.message : String(error),
      status: 502,
    }
  }
}

/**
 * Sends an email-verification message containing an absolute verification link.
 * @param {Env} env - The Worker environment bindings.
 * @param {string} to - Recipient email address.
 * @param {string} token - The email-verification token value.
 * @returns {Promise<Envelope>} Result of the underlying {@link sendEmail} call.
 */
export async function sendVerificationEmail(env: Env, to: string, token: string): Promise<Envelope> {
  const origin = appOrigin(env)
  if (!origin) {
    return {
      error: true,
      message: "Email delivery is not configured.",
      status: 500,
    }
  }

  const link = `${origin}/api/db/email/verify?token=${encodeURIComponent(token)}`
  const content = verificationEmail(link)
  return sendEmail(env, {
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    category: "Email Verification",
  })
}

/**
 * Sends a password-reset message containing an absolute reset link.
 * @param {Env} env - The Worker environment bindings.
 * @param {string} to - Recipient email address.
 * @param {string} token - The password-reset token value.
 * @returns {Promise<Envelope>} Result of the underlying {@link sendEmail} call.
 */
export async function sendPasswordResetEmail(env: Env, to: string, token: string): Promise<Envelope> {
  const origin = appOrigin(env)
  if (!origin) {
    return {
      error: true,
      message: "Email delivery is not configured.",
      status: 500,
    }
  }

  const link = `${origin}/reset/set?token=${encodeURIComponent(token)}`
  const content = passwordResetEmail(link)
  return sendEmail(env, {
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    category: "Password Reset",
  })
}

/**
 * Sends a 2FA-bypass message containing an absolute, single-use login link.
 * @param {Env} env - The Worker environment bindings.
 * @param {string} to - Recipient email address (a verified address on the account).
 * @param {string} token - The 2FA-bypass token value.
 * @returns {Promise<Envelope>} Result of the underlying {@link sendEmail} call.
 */
export async function sendTwoFactorBypassEmail(env: Env, to: string, token: string): Promise<Envelope> {
  const origin = appOrigin(env)
  if (!origin) {
    return {
      error: true,
      message: "Email delivery is not configured.",
      status: 500,
    }
  }

  const link = `${origin}/api/db/2fa/bypass/verify?token=${encodeURIComponent(token)}`
  const content = twoFactorBypassEmail(link)
  return sendEmail(env, {
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    category: "2FA Bypass",
  })
}

/**
 * Sends an organisation-invitation message containing an absolute accept link.
 * @param {Env} env - The Worker environment bindings.
 * @param {string} to - Recipient email address (the invited address).
 * @param {string} token - The invitation token value.
 * @param {string} organisationName - Name of the inviting organisation.
 * @returns {Promise<Envelope>} Result of the underlying {@link sendEmail} call.
 */
export async function sendOrganisationInvitationEmail(env: Env, to: string, token: string, organisationName: string): Promise<Envelope> {
  const origin = appOrigin(env)
  if (!origin) {
    return {
      error: true,
      message: "Email delivery is not configured.",
      status: 500,
    }
  }

  const link = `${origin}/invite?token=${encodeURIComponent(token)}`
  const content = organisationInvitationEmail(link, organisationName)
  return sendEmail(env, {
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    category: "Organisation Invitation",
  })
}
