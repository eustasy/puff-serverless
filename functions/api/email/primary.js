import { verifySession } from "../../../src/session_auth.js";
import { setPrimaryEmail } from "../../../src/emails.js";

export async function onRequestPost(context) {

  let user_uuid;
  try {
    const tempClient = new Client(context.env.HYPERDRIVE.connectionString);
    await tempClient.connect();
    // Assuming session token is passed in Authorization header as Bearer token
    const authHeader = context.request.headers.get("Authorization");
    const sessionToken = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : null;

    if (!sessionToken) {
      await tempClient.end();
      return new Response(
        JSON.stringify({ error: "Authorization token is missing or invalid." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const sessionResult = await verifySession(tempClient, sessionToken);
    await tempClient.end();

    if (sessionResult.error) {
      return new Response(
        JSON.stringify({ error: sessionResult.error }),
        { status: sessionResult.status || 401, headers: { "Content-Type": "application/json" } }
      );
    }
    user_uuid = sessionResult.user_uuid;
  } catch (e) {
    console.error("Session verification error:", e);
    return new Response(
      JSON.stringify({ error: "Session verification failed." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 2: Parse JSON body
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const new_primary_email = requestBody.new_primary_email;

  // Step 3: Input Validation
  if (
    !new_primary_email ||
    typeof new_primary_email !== "string" ||
    !new_primary_email.includes("@")
  ) {
    return new Response(
      JSON.stringify({ error: "New primary email is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const result = await setPrimaryEmail(context, user_uuid, new_primary_email);

    if (result.error) {
      return new Response(
        JSON.stringify({ error: result.message }),
        { status: result.status || 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ message: result.message }),
      { status: result.status || 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in set primary email endpoint:", error);
    return new Response(
      JSON.stringify({ error: "Failed to change primary email due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return await onRequestPost(context);
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Allow": "POST", "Content-Type": "application/json" },
  });
}
