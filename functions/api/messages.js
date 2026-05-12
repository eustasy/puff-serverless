// /api/messages.js — Returns a trusted HTML fragment for a given code

const MESSAGE_MAP = {
  registration_success:
    '<p class="result-positive">Registration successful. Please check your email to verify.</p>',
  password_reset_success:
    '<p class="result-positive">Password reset successful. Please log in with your new password.</p>',
  email_verification_success:
    '<p class="result-positive">Email verification successful. Please log in.</p>',
  logout_success: '<p class="result-positive">Logout successful.</p>',
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const code = url.searchParams.get("code")
  const html = MESSAGE_MAP[code] || ""
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  })
}

export async function onRequest(context) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
