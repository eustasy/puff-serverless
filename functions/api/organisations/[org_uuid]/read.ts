import { readOrganisation } from "../../../../src/organisations.js"
import { can, ORG_ROLES } from "../../../../src/permissions.js"
import { escapeHtml } from "../../../../src/utilities/escape.js"
import { htmlResponse, resultNegative, methodNotAllowed } from "../../../../src/utilities/responses.js"

/**
 * Renders an organisation's management panel: details and an edit form, the
 * lifecycle buttons, and the teams / members / invitations sub-sections —
 * each control only shown when the caller's role permits it. The panel is
 * loaded into `#organisation-detail` on the account page; its sub-lists are
 * fetched by the nested `hx-get` containers below.
 */
export const onRequestGet: Handler<"org_uuid"> = async (context) => {
  const orgRoles = context.data.orgRoles ?? []
  if (!can(orgRoles, "org:view")) {
    return resultNegative("You do not have access to this organisation.", 403)
  }

  const org_uuid = String(context.params.org_uuid)
  const result = await readOrganisation(context.data.dbClient!, org_uuid)
  if (!result.success) {
    return resultNegative(result.message, result.status)
  }
  const org = result.organisation
  const base = `/api/organisations/${encodeURIComponent(org_uuid)}`
  const roleOptions = ORG_ROLES.map((role) => `<option value="${role}">${role}</option>`).join("")

  let html = `<section class="organisation-panel">
  <h3>${escapeHtml(org.org_name)}${org.org_active ? "" : " (disabled)"}</h3>
  <div id="org-message-area" class="result-area spacer-bottom"></div>`

  if (can(orgRoles, "org:update")) {
    html += `
  <form hx-post="${base}/update" hx-target="#org-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Name:
      <input type="text" name="name" value="${escapeHtml(org.org_name)}" maxlength="128" required class="form-input" /></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Save</button></div>
  </form>`
  }

  const lifecycle: string[] = []
  if (can(orgRoles, "org:disable")) {
    lifecycle.push(
      org.org_active
        ? `<button class="btn-danger" hx-post="${base}/disable" hx-target="#org-message-area" hx-swap="innerHTML" hx-confirm="Disable this organisation?">Disable</button>`
        : `<button class="btn-save" hx-post="${base}/enable" hx-target="#org-message-area" hx-swap="innerHTML">Enable</button>`
    )
  }
  if (can(orgRoles, "org:delete")) {
    lifecycle.push(
      `<button class="btn-danger" hx-post="${base}/delete" hx-target="#org-message-area" hx-swap="innerHTML" hx-confirm="Permanently delete this organisation, its teams and memberships? This cannot be undone.">Delete</button>`
    )
  }
  if (lifecycle.length > 0) {
    html += `\n  <p>${lifecycle.join(" ")}</p>`
  }

  html += `\n  <h4>Teams</h4>`
  if (can(orgRoles, "org:teams:create")) {
    html += `
  <form hx-post="${base}/teams/create" hx-target="#org-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Team name:
      <input type="text" name="name" maxlength="128" required class="form-input" /></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Create Team</button></div>
  </form>`
  }
  html += `
  <div id="org-teams" hx-get="${base}/teams/list" hx-trigger="load, teamsChanged from:body" hx-swap="innerHTML"><p>Loading teams...</p></div>
  <div id="team-detail" class="spacer-top"></div>`

  html += `\n  <h4>Members</h4>`
  if (can(orgRoles, "org:members:invite")) {
    html += `
  <form hx-post="${base}/members/add" hx-target="#org-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Email address:
      <input type="email" name="email" required class="form-input" /></label></div>
    <div class="grid-item"><label>Role:
      <select name="role" class="form-input">${roleOptions}</select></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Add Member</button></div>
  </form>`
  }
  html += `
  <div id="org-members" hx-get="${base}/members/list" hx-trigger="load, organisationMembersChanged from:body" hx-swap="innerHTML"><p>Loading members...</p></div>`

  if (can(orgRoles, "org:members:invite")) {
    html += `
  <h4>Invitations</h4>
  <form hx-post="${base}/members/invite" hx-target="#org-message-area" hx-swap="innerHTML" class="grid-container">
    <div class="grid-item"><label>Email:
      <input type="email" name="email" required class="form-input" /></label></div>
    <div class="grid-item"><label>Role:
      <select name="roles" class="form-input">${roleOptions}</select></label></div>
    <div class="grid-item"><button type="submit" class="btn-save">Send Invitation</button></div>
  </form>
  <div id="org-invitations" hx-get="${base}/invitations/list" hx-trigger="load, organisationInvitationsChanged from:body" hx-swap="innerHTML"><p>Loading invitations...</p></div>`
  }

  html += `\n</section>`
  return htmlResponse(html)
}

export const onRequest: Handler = async () => methodNotAllowed("GET")
