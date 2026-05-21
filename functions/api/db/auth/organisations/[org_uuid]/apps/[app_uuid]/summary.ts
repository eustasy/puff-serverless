import { summariseLicensing } from "../../../../../../../../src/entitlements.js"
import { can } from "../../../../../../../../src/permissions.js"
import { escapeHtml } from "../../../../../../../../src/utilities/escape.js"
import {
  htmlResponse,
  methodNotAllowed,
  resultNegative,
} from "../../../../../../../../src/utilities/responses.js"

/**
 * Read-only summary of how this app is licensed in this organisation: the
 * mode, the count of assigned/active subjects, and (for floating) the pool
 * size. Returns an HTML fragment for embedding in the org admin page.
 */
export const onRequestGet: Handler<"app_uuid" | "org_uuid"> = async (
  context
) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:entitlements:read")) {
    return resultNegative("You cannot view this data.", 403)
  }
  const app = context.data.app!
  const org_uuid = String(context.params.org_uuid)

  const result = await summariseLicensing(context.data.dbClient!, app, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }

  const rows: string[] = [
    `<tr><th scope="row">Mode</th><td>${escapeHtml(result.mode)}</td></tr>`,
  ]
  if (result.mode === "floating") {
    rows.push(
      `<tr><th scope="row">Active seats</th><td>${result.active ?? 0}</td></tr>`,
      `<tr><th scope="row">Pool size</th><td>${result.max === null || result.max === undefined ? "not set" : result.max}</td></tr>`
    )
  } else if (result.mode === "seat" || result.mode === "usage") {
    rows.push(
      `<tr><th scope="row">Assigned users</th><td>${result.assigned}</td></tr>`
    )
  }
  return htmlResponse(
    `<table class="licence-summary"><tbody>${rows.join("")}</tbody></table>`
  )
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
