import type { HookSeverity } from "./types.js"

// Single source of truth for the event vocabulary. Handlers import these
// constants — never bare strings — so a typo is a typecheck error.
//
// Adding an event = add a key here, then add a default severity in
// `DEFAULT_SEVERITY` below. The exhaustiveness check on that record
// guarantees the second step.

export const EVENTS = {
  ACCOUNT_REGISTERED: "account.registered",
  ACCOUNT_LOGIN_SUCCESS: "account.login.success",
  ACCOUNT_LOGIN_FAILED: "account.login.failed",
  ACCOUNT_LOGOUT: "account.logout",
  ACCOUNT_EMAIL_ADDED: "account.email.added",
  ACCOUNT_EMAIL_REMOVED: "account.email.removed",
  ACCOUNT_EMAIL_SET_PRIMARY: "account.email.set_primary",
  ACCOUNT_EMAIL_VERIFICATION_RESENT: "account.email.verification.resent",
  ACCOUNT_PASSWORD_RESET_REQUESTED: "account.password.reset.requested",
  ACCOUNT_PASSWORD_RESET_COMPLETED: "account.password.reset.completed",
  ACCOUNT_PASSWORD_CHANGED: "account.password.changed",
  ACCOUNT_2FA_SETUP_STARTED: "account.2fa.setup.started",
  ACCOUNT_2FA_SETUP_VERIFIED: "account.2fa.setup.verified",
  ACCOUNT_2FA_DISABLED: "account.2fa.disabled",
  ACCOUNT_PASSKEY_DELETED: "account.passkey.deleted",
  ACCOUNT_EXTERNAL_IDENTITY_LINKED: "account.external_identity.linked",
  ACCOUNT_EXTERNAL_IDENTITY_UNLINKED: "account.external_identity.unlinked",

  ORG_CREATED: "org.created",
  ORG_UPDATED: "org.updated",
  ORG_ENABLED: "org.enabled",
  ORG_DISABLED: "org.disabled",
  ORG_DELETED: "org.deleted",
  ORG_MEMBER_ADDED: "org.member.added",
  ORG_MEMBER_INVITED: "org.member.invited",
  ORG_MEMBER_REMOVED: "org.member.removed",
  ORG_MEMBER_ROLES_CHANGED: "org.member.roles.changed",
  ORG_INVITATION_REVOKED: "org.invitation.revoked",
  ORG_INVITATION_ACCEPTED: "org.invitation.accepted",
  ORG_TEAM_CREATED: "org.team.created",
  ORG_TEAM_UPDATED: "org.team.updated",
  ORG_TEAM_DELETED: "org.team.deleted",
  ORG_TEAM_MEMBER_ADDED: "org.team.member.added",
  ORG_TEAM_MEMBER_REMOVED: "org.team.member.removed",
  ORG_TEAM_MEMBER_ROLES_CHANGED: "org.team.member.roles.changed",
  ORG_ENTITLEMENTS_SET: "org.entitlements.set",
  ORG_ENTITLEMENTS_REMOVED: "org.entitlements.removed",
  ORG_TEAM_ENTITLEMENTS_SET: "org.team.entitlements.set",
  ORG_TEAM_ENTITLEMENTS_REMOVED: "org.team.entitlements.removed",
  ORG_USER_ENTITLEMENTS_SET: "org.user.entitlements.set",
  ORG_USER_ENTITLEMENTS_REMOVED: "org.user.entitlements.removed",

  OAUTH_SIGNING_KEY_ROTATED: "oauth.signing_key.rotated",
  OAUTH_SIGNING_KEY_ROTATION_FAILED: "oauth.signing_key.rotation.failed",
  OAUTH_SIGNING_KEY_RETIRED_PROMOTED: "oauth.signing_key.retired.promoted",

  BILLING_CUSTOMER_CREATED: "billing.customer.created",
  BILLING_INVOICE_ISSUED: "billing.invoice.issued",
  BILLING_INVOICE_PAID: "billing.invoice.paid",
  BILLING_INVOICE_VOIDED: "billing.invoice.voided",
  BILLING_PAYMENT_FAILED: "billing.payment.failed",
  BILLING_PAYMENT_SUCCEEDED: "billing.payment.succeeded",
  BILLING_SUBSCRIPTION_CANCELED: "billing.subscription.canceled",
  BILLING_SUBSCRIPTION_CREATED: "billing.subscription.created",
  BILLING_SUBSCRIPTION_PAUSED: "billing.subscription.paused",
  BILLING_SUBSCRIPTION_RESUMED: "billing.subscription.resumed",
  BILLING_SUBSCRIPTION_UPDATED: "billing.subscription.updated",
  BILLING_USAGE_RECORDED: "billing.usage.recorded",
} as const

export type EventType = (typeof EVENTS)[keyof typeof EVENTS]

// Default severity per event type. A `Record<EventType, _>` makes adding a
// new event to `EVENTS` a typecheck error here until severity is assigned.
//
// Tiering rule of thumb:
//   info     — routine, expected, high-volume (logins, verification resends)
//   notice   — meaningful state change (member added, email changed)
//   warning  — failed attempt or suspicious action (failed login)
//   alert    — security-sensitive change (password change, 2FA off, org delete)
//
// These are *defaults*; callers may override via the `event_severity` field
// on the emit payload when context warrants escalation.
export const DEFAULT_SEVERITY: Record<EventType, HookSeverity> = {
  "account.registered": "notice",
  "account.login.success": "info",
  "account.login.failed": "warning",
  "account.logout": "info",
  "account.email.added": "notice",
  "account.email.removed": "notice",
  "account.email.set_primary": "notice",
  "account.email.verification.resent": "info",
  "account.password.reset.requested": "notice",
  "account.password.reset.completed": "alert",
  "account.password.changed": "alert",
  "account.2fa.setup.started": "info",
  "account.2fa.setup.verified": "alert",
  "account.2fa.disabled": "alert",
  "account.passkey.deleted": "notice",
  "account.external_identity.linked": "notice",
  "account.external_identity.unlinked": "notice",

  "org.created": "notice",
  "org.updated": "notice",
  "org.enabled": "notice",
  "org.disabled": "alert",
  "org.deleted": "alert",
  "org.member.added": "notice",
  "org.member.invited": "notice",
  "org.member.removed": "notice",
  "org.member.roles.changed": "notice",
  "org.invitation.revoked": "notice",
  "org.invitation.accepted": "notice",
  "org.team.created": "notice",
  "org.team.updated": "notice",
  "org.team.deleted": "notice",
  "org.team.member.added": "notice",
  "org.team.member.removed": "notice",
  "org.team.member.roles.changed": "notice",
  "org.entitlements.set": "notice",
  "org.entitlements.removed": "notice",
  "org.team.entitlements.set": "notice",
  "org.team.entitlements.removed": "notice",
  "org.user.entitlements.set": "notice",
  "org.user.entitlements.removed": "notice",

  "oauth.signing_key.rotated": "alert",
  "oauth.signing_key.rotation.failed": "critical",
  "oauth.signing_key.retired.promoted": "alert",

  "billing.customer.created": "notice",
  "billing.invoice.issued": "notice",
  "billing.invoice.paid": "notice",
  "billing.invoice.voided": "notice",
  "billing.payment.failed": "warning",
  "billing.payment.succeeded": "notice",
  "billing.subscription.canceled": "alert",
  "billing.subscription.created": "notice",
  "billing.subscription.paused": "notice",
  "billing.subscription.resumed": "notice",
  "billing.subscription.updated": "notice",
  "billing.usage.recorded": "debug",
}
