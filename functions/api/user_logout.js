import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in user_logout. Check Pages Function configuration."
    );
    return new Response("Internal server configuration error.", { status: 500 });
  }

  // Step 1: Get the token from FormData
  let token;
  try {
    const formdata = await context.request.formData();
    token = formdata.get("sessionToken");
  } catch (e) {
    console.error("Error parsing FormData for logout:", e);
    return new Response("Invalid request format.", { status: 400 });
  }

  if (!token) {
    return new Response("Session token is missing in request body.", { status: 400 });
  }

  // Step 2: Attempt to delete the session token
  try {
    const deleteStmt = await context.env.DATABASE.prepare(
      "DELETE FROM sessions WHERE session_id = ?1"
    )
      .bind(token)
      .run();

    const changes = deleteStmt.meta.changes !== undefined ? deleteStmt.meta.changes : 0;
    return new Response(`Sessions deleted: ${changes}`, { status: 200 });

  } catch (error) {
    console.error("Error during session deletion:", error);
    return new Response("Logout failed due to a server error.", { status: 500 });
  }
}

// Fallback for other methods if needed
export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
}
