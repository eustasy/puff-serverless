import { sessionAuthWithCookie } from "../../../src/sessions.js";
import { setPrimaryEmail } from "../../../src/emails.js";

export async function onRequestPost(context) {
  try {
    const sessionResult = await sessionAuthWithCookie(context);
    if (sessionResult.error) {
      return new Response(`<p class="error">${sessionResult.error}</p>`, {
        status: sessionResult.status || 401,
        headers: { "Content-Type": "text/html" },
      });
    }
    const { user_uuid } = sessionResult;

    const formData = await context.request.formData();
    const new_primary_email = formData.get("email_id"); // Assuming email_id is sent, which corresponds to an email address

    if (!new_primary_email || typeof new_primary_email !== "string" || !new_primary_email.includes("@")) {
      // This check might be redundant if email_id is a UUID, adjust as per actual data model
      // If email_id is an actual email address string, this validation is fine.
      // For now, assuming new_primary_email is the actual email string based on setPrimaryEmail function signature
      return new Response("<p class=\"error\">New primary email is missing or invalid.</p>", {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    const result = await setPrimaryEmail(context, user_uuid, new_primary_email);

    if (result.error) {
      return new Response(`<p class=\"error\">${result.message}</p>`, {
        status: result.status || 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    // On success, return a success message and trigger an event for HTMX to refresh the list
    return new Response(`<p class=\"success\">${result.message}</p>`, {
      status: result.status || 200,
      headers: {
        "Content-Type": "text/html",
        "HX-Trigger": "emailListChanged",
      },
    });
  } catch (error) {
    console.error("Error in set primary email endpoint:", error);
    let errorMessage = "Failed to change primary email due to a server error.";
    if (error instanceof TypeError && error.message.includes("formData")) {
        errorMessage = "Invalid request format. Expected form data.";
    }
    return new Response(`<p class=\"error\">${errorMessage}</p>`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context);
  }
  return new Response("<p class=\"error\">Method Not Allowed</p>", {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "text/html" },
  });
}
