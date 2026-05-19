import { deleteKeyValue } from "../../../../../src/user-keyvalues.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"

/**
 * Deletes a single self-owned key/value pair for the authenticated user
 * (owner and subject are both the caller).
 */
export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!
  const owner = { type: "user" as const, user_uuid }

  try {
    const formData = await context.request.formData()
    const rawKey = formData.get("key")

    if (typeof rawKey !== "string" || rawKey.trim() === "") {
      return new Response('<p class="result-negative">A key is required.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }

    const key = rawKey.trim()
    const result = await deleteKeyValue(dbClient, user_uuid, owner, key)

    if (!result.success) {
      return new Response(
        `<p class="result-negative">${escapeHtml(result.message)}</p>`,
        {
          status: result.status,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    return new Response(
      `<p class="result-positive">Key "${escapeHtml(key)}" deleted.</p>`,
      {
        status: result.status,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "keyValueListChanged",
        },
      }
    )
  } catch (error) {
    console.error("Error in /api/db/auth/keyvalues/remove:", error)
    let message = "Failed to delete key due to a server error."
    if (error instanceof TypeError && error.message.includes("formData")) {
      message = "Invalid request format. Expected form data."
    }
    return new Response(`<p class="result-negative">${message}</p>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    })
  }
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
