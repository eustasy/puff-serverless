export const onRequestGet: Handler = async (context) => {
  const base = (context.env.APP_URL || "").replace(/\/$/, "")
  const pages = ["/", "/login", "/register", "/reset/request"]
  const urls = pages
    .map((p) => `  <url><loc>${base}${p}</loc></url>`)
    .join("\n")
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  })
}

export const onRequest: Handler = async () =>
  new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
