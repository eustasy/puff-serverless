export async function configurationCheck(context) {
  if (!context || !context.env || !context.env.HYPERDRIVE || !context.env.HYPERDRIVE.connectionString) {
    console.error("Hyperdrive binding [HYPERDRIVE] not found in middleware. Check Pages Function configuration.");
    return new Response(
      '<h1 class="result-negative">Server Error</h1><p>A configuration problem prevented us from processing your request. Please try again later.</p>',
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }
}