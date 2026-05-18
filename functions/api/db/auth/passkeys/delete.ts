import { deletePasskey } from "../../../../../src/passkeys.js"

export const onRequestPost: Handler = async (context) => {
  const dbClient = context.data.dbClient!
  const user_uuid = context.data.user_uuid!

  let passkey_uuid: string | null = null
  try {
    const formData = await context.request.formData()
    const raw = formData.get("passkey_uuid")
    if (typeof raw === "string") passkey_uuid = raw
  } catch {
    return new Response('<p class="result-negative">Invalid request.</p>', {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })
  }

  if (!passkey_uuid) {
    return new Response(
      '<p class="result-negative">Passkey ID is required.</p>',
      { status: 400, headers: { "Content-Type": "text/html" } }
    )
  }

  const result = await deletePasskey(dbClient, passkey_uuid, user_uuid)
  if (result.error) {
    return new Response(
      '<p class="result-negative">Could not remove passkey. Please try again.</p>',
      { status: 500, headers: { "Content-Type": "text/html" } }
    )
  }
  if (!result.success) {
    return new Response('<p class="result-negative">Passkey not found.</p>', {
      status: 404,
      headers: { "Content-Type": "text/html" },
    })
  }

  return new Response('<p class="result-positive">Passkey removed.</p>', {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "HX-Trigger": "passkeysChanged",
    },
  })
}

export const onRequest: Handler = async () => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  })
}
