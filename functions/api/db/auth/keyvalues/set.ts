import {
  setKeyValue,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
} from "../../../../../src/keyvalues.js"
import { escapeHtml } from "../../../../../src/utilities/escape.js"

/**
 * Creates or updates a single key/value pair for the authenticated user.
 * A new key and an existing key are both accepted (upsert) — the response
 * reports which happened.
 */
export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  try {
    const formData = await context.request.formData()
    const rawKey = formData.get("key")
    const rawValue = formData.get("value")

    if (typeof rawKey !== "string" || rawKey.trim() === "") {
      return new Response('<p class="result-negative">A key is required.</p>', {
        status: 400,
        headers: { "Content-Type": "text/html" },
      })
    }
    if (typeof rawValue !== "string") {
      return new Response(
        '<p class="result-negative">A value is required.</p>',
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const key = rawKey.trim()

    if (key.length > MAX_KEY_LENGTH) {
      return new Response(
        `<p class="result-negative">Keys cannot be longer than ${MAX_KEY_LENGTH} characters.</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }
    if (rawValue.length > MAX_VALUE_LENGTH) {
      return new Response(
        `<p class="result-negative">Values cannot be longer than ${MAX_VALUE_LENGTH} characters.</p>`,
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const result = await setKeyValue(dbClient, user_uuid, key, rawValue)

    if (!result.success) {
      return new Response(
        `<p class="result-negative">${escapeHtml(result.message)}</p>`,
        {
          status: result.status,
          headers: { "Content-Type": "text/html" },
        }
      )
    }

    const verb = result.created ? "created" : "updated"
    return new Response(
      `<p class="result-positive">Key "${escapeHtml(key)}" ${verb}.</p>`,
      {
        status: result.status,
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": "keyValueListChanged",
        },
      }
    )
  } catch (error) {
    console.error("Error in /api/db/auth/keyvalues/set:", error)
    let message = "Failed to save key due to a server error."
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
