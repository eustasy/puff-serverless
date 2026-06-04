// Transactional email templates. Pure string builders — no I/O, no env access.
// Each builder returns matching plain-text and HTML bodies plus a subject line.

import { escapeHtml } from "./utilities/escape.js"

export interface EmailContent {
  subject: string
  text: string
  html: string
}

// Minimal, inline-styled HTML shell. Email clients ignore external stylesheets
// and our CSP, so styling stays inline and structure stays simple.
function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="font-family: sans-serif; line-height: 1.5; color: #1a1a1a;">
    <h1 style="font-size: 1.2em;">${escapeHtml(heading)}</h1>
    ${bodyHtml}
  </body>
</html>`
}

/**
 * Builds the email-verification message sent after registration or a resend request.
 * @param {string} link - Absolute URL of the verification endpoint (includes the token).
 * @returns {EmailContent} Subject, plain-text, and HTML bodies.
 */
export function verificationEmail(link: string): EmailContent {
  const heading = "Verify your email address"
  return {
    subject: heading,
    text:
      `Welcome! Please verify your email address by opening the link below:\n\n` +
      `${link}\n\n` +
      `This link expires in 24 hours. If you did not create an account, you can ignore this email.`,
    html: layout(
      heading,
      `<p>Welcome! Please verify your email address using the link below.</p>
    <p><a href="${escapeHtml(link)}">Verify email address</a></p>
    <p>This link expires in 24 hours. If you did not create an account, you can ignore this email.</p>`
    ),
  }
}

/**
 * Builds the password-reset message sent when a reset is requested.
 * @param {string} link - Absolute URL of the reset endpoint (includes the token).
 * @returns {EmailContent} Subject, plain-text, and HTML bodies.
 */
export function passwordResetEmail(link: string): EmailContent {
  const heading = "Reset your password"
  return {
    subject: heading,
    text:
      `A password reset was requested for your account. To set a new password, open the link below:\n\n` +
      `${link}\n\n` +
      `This link expires in 24 hours. If you did not request this, you can ignore this email and your password will stay the same.`,
    html: layout(
      heading,
      `<p>A password reset was requested for your account.</p>
    <p><a href="${escapeHtml(link)}">Set a new password</a></p>
    <p>This link expires in 24 hours. If you did not request this, you can ignore this email and your password will stay the same.</p>`
    ),
  }
}

/**
 * Builds the 2FA-bypass message sent when a user cannot access their authenticator.
 * The link is single-use and expires in 1 hour.
 * @param {string} link - Absolute URL of the bypass-verify endpoint (includes the token).
 * @returns {EmailContent} Subject, plain-text, and HTML bodies.
 */
export function twoFactorBypassEmail(link: string): EmailContent {
  const heading = "Complete your login without a code"
  return {
    subject: heading,
    text:
      `A login to your account is waiting for two-factor authentication. ` +
      `If you cannot use your authenticator app, open the link below to complete the login:\n\n` +
      `${link}\n\n` +
      `This link expires in 1 hour and can be used once. If you did not try to log in, you can ignore this email and your account stays protected.`,
    html: layout(
      heading,
      `<p>A login to your account is waiting for two-factor authentication.</p>
    <p>If you cannot use your authenticator app, complete the login using the link below.</p>
    <p><a href="${escapeHtml(link)}">Complete login</a></p>
    <p>This link expires in 1 hour and can be used once. If you did not try to log in, you can ignore this email and your account stays protected.</p>`
    ),
  }
}

/**
 * Builds the organisation-invitation message sent when a user is invited to
 * join an organisation.
 * @param {string} link - Absolute URL of the invitation-accept page (includes the token).
 * @param {string} organisationName - Name of the inviting organisation.
 * @returns {EmailContent} Subject, plain-text, and HTML bodies.
 */
export function organisationInvitationEmail(link: string, organisationName: string): EmailContent {
  const heading = `You've been invited to join ${organisationName}`
  return {
    subject: heading,
    text:
      `You have been invited to join the organisation "${organisationName}".\n\n` +
      `Open the link below to accept — you can sign in, or create an account if you do not have one:\n\n` +
      `${link}\n\n` +
      `This invitation expires in 7 days. If you were not expecting it, you can ignore this email.`,
    html: layout(
      heading,
      `<p>You have been invited to join the organisation <strong>${escapeHtml(organisationName)}</strong>.</p>
    <p><a href="${escapeHtml(link)}">Accept invitation</a></p>
    <p>You can sign in, or create an account if you do not have one. This invitation expires in 7 days. If you were not expecting it, you can ignore this email.</p>`
    ),
  }
}
