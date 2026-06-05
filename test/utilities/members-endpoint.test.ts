import { describe, it, expect } from "vitest"
import { renderMembersTable } from "../../src/utilities/members-endpoint.js"
import type { ScopeMember } from "../../src/memberships.js"

const member = (over: Partial<ScopeMember> = {}): ScopeMember => ({
  user_uuid: "u1",
  user_name: "Ada",
  roles: ["org:owner"],
  joined_at: new Date(0),
  ...over,
})

const opts = {
  roles: ["org:owner", "org:member"] as const,
  base: "/api/db/auth/organisations/o1",
  messageArea: "org-members-msg",
  confirmMessage: "Remove this member?",
  canEditRoles: true,
  canRemove: true,
}

describe("renderMembersTable", () => {
  it("renders a role-edit form with the member's current roles pre-checked", async () => {
    const body = await renderMembersTable([member()], opts).text()
    expect(body).toContain("Edit roles")
    expect(body).toContain('value="org:owner" checked')
    expect(body).toContain('value="org:member" ')
    expect(body).not.toContain('value="org:member" checked')
    expect(body).toContain('hx-post="/api/db/auth/organisations/o1/members/roles"')
  })

  it("renders a remove button with the confirm message when removable", async () => {
    const body = await renderMembersTable([member()], opts).text()
    expect(body).toContain("Remove")
    expect(body).toContain('hx-confirm="Remove this member?"')
    expect(body).toContain("/members/remove")
  })

  it("renders neither actions when the caller lacks both permissions", async () => {
    const body = await renderMembersTable([member()], { ...opts, canEditRoles: false, canRemove: false }).text()
    expect(body).not.toContain("Edit roles")
    expect(body).not.toContain("Remove")
    expect(body).toContain("Ada")
  })

  it("escapes the member name and joins roles for display", async () => {
    const body = await renderMembersTable([member({ user_name: "<script>", roles: ["a", "b"] })], opts).text()
    expect(body).toContain("<td>&lt;script&gt;</td>")
    expect(body).toContain("<td>a, b</td>")
  })
})
