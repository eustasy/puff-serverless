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

export const onRequestGet: Handler = async (context) => {
  const url = new URL(context.request.url)
  const code = url.searchParams.get("code")
  const html = (code && MESSAGE_MAP[code as keyof typeof MESSAGE_MAP]) || ""
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  })
}

export const onRequest: Handler = async (context) => {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET" },
  })
}
