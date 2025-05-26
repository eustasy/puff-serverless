import { verifySession } from "../../src/session_auth.js"; // Adjust path as needed

export async function onRequestPost(context) {
  // Validate context and DATABASE binding
  if (!context || !context.env || !context.env.DATABASE) {
    console.error(
      "D1 Database binding [DATABASE] not found in change_primary_email. Check Pages Function configuration."
    );
    return new Response(
      JSON.stringify({ error: "Internal server configuration error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 1: Session Verification
  const sessionVerificationResult = await verifySession(context);
  if (sessionVerificationResult instanceof Response) {
    return sessionVerificationResult; // Session invalid or error occurred
  }
  const user_uuid = context.data.user_uuid;

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
  if (!new_primary_email || typeof new_primary_email !== "string" || !new_primary_email.includes("@")) {
    return new Response(
      JSON.stringify({ error: "New primary email is missing or invalid." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    // Step 4: Target Email Validation
    const targetEmailRecord = await context.env.DATABASE.prepare(
      "SELECT email_id, is_verified, is_primary FROM emails WHERE user_uuid = ?1 AND email_address = ?2"
    )
      .bind(user_uuid, new_primary_email)
      .first();

    if (!targetEmailRecord) {
      return new Response(
        JSON.stringify({
          error: "Email address not found for this account. Please add it as a backup email first.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (targetEmailRecord.is_verified !== 1) {
      return new Response(
        JSON.stringify({
          error: "This email address must be verified before it can be made primary.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (targetEmailRecord.is_primary === 1) {
        return new Response(
            JSON.stringify({
              message: "This email address is already your primary email.",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } } // Or 400 if considered an error
          );
    }

    // Step 5: Change Primary Email Logic
    // D1 does not support multi-statement transactions directly in Functions.
    // We perform these sequentially. If the second one fails, the first one is not rolled back.

    // Find current primary email
    const currentPrimaryRecord = await context.env.DATABASE.prepare(
      "SELECT email_id, email_address FROM emails WHERE user_uuid = ?1 AND is_primary = 1"
    )
      .bind(user_uuid)
      .first();

    let oldPrimaryEmailDemoted = false;
    if (currentPrimaryRecord) {
      // Demote Old Primary
      const demoteResult = await context.env.DATABASE.prepare(
        "UPDATE emails SET is_primary = 0 WHERE user_uuid = ?1 AND email_id = ?2 AND is_primary = 1"
      )
        .bind(user_uuid, currentPrimaryRecord.email_id)
        .run();
      if(demoteResult.meta.changes > 0) {
        oldPrimaryEmailDemoted = true;
      } else {
        // This could happen if another request changed the primary in the meantime.
        // Or if the record fetched as primary is no longer primary (race condition).
        // For now, we'll proceed, as the main goal is to promote the new one.
        console.warn(`Could not demote old primary email ${currentPrimaryRecord.email_address} for user ${user_uuid} or it was already demoted.`);
      }
    } else {
        // No current primary found, this is unusual but not necessarily an error for promoting a new one.
        console.warn(`No current primary email found for user ${user_uuid} when trying to change primary to ${new_primary_email}.`);
        oldPrimaryEmailDemoted = true; // Effectively, there's no old primary to demote.
    }


    // Promote New Primary
    const promoteResult = await context.env.DATABASE.prepare(
      "UPDATE emails SET is_primary = 1 WHERE user_uuid = ?1 AND email_id = ?2 AND is_verified = 1"
    )
      .bind(user_uuid, targetEmailRecord.email_id)
      .run();

    if (promoteResult.meta.changes > 0) {
      // Step 6: Response
      return new Response(
        JSON.stringify({ message: "Primary email changed successfully." }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // Promotion failed. This is a problem.
      // Attempt to roll back the demotion of the old primary if it happened and we have its ID.
      // This is best-effort due to lack of transactions.
      if (oldPrimaryEmailDemoted && currentPrimaryRecord) {
        await context.env.DATABASE.prepare(
          "UPDATE emails SET is_primary = 1 WHERE user_uuid = ?1 AND email_id = ?2"
        )
          .bind(user_uuid, currentPrimaryRecord.email_id)
          .run();
          console.error(`Failed to promote ${new_primary_email} for user ${user_uuid}. Attempted to restore old primary ${currentPrimaryRecord.email_address}.`);
          return new Response(
            JSON.stringify({ error: "Failed to promote new primary email. Old primary status potentially restored." }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
      }
      console.error(`Failed to promote ${new_primary_email} for user ${user_uuid} and no old primary to restore or demotion failed.`);
      return new Response(
        JSON.stringify({ error: "Failed to change primary email due to an unexpected issue." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

  } catch (error) {
    console.error("Error during changing primary email:", error);
    return new Response(
      JSON.stringify({ error: "Failed to change primary email due to a server error." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
  // For POST requests, Cloudflare Pages will automatically route to onRequestPost.
}
