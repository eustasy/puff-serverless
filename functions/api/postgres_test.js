export async function onRequest(context) {
  const { Client } = require("pg");
  const client = new Client(context.env.HYPERDRIVE.connectionString);

  await client.connect();
  try {
    const results = await client.query("SELECT NOW()");
    console.log(results);
    return Response.json(results);
  } catch (err) {
    console.error("error executing query:", err);
    return Response.json({ error: "Failed to execute query" }, { status: 500 });
  } finally {
    client.end();
  }

}
