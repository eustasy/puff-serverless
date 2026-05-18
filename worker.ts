// Worker entry point.
//
// `npm run build` runs the Pages Functions compiler (`wrangler pages functions
// build`), which turns `functions/` into a Worker bundle at
// `dist/worker/index.js` — but that bundle only exports a `fetch` handler.
// Cloudflare Cron Triggers also need a `scheduled` handler, and the Pages
// compiler cannot emit one.
//
// So `main` in `wrangler.jsonc` points here, not at the compiled bundle: this
// entry forwards `fetch` to the compiled bundle and adds the `scheduled`
// handler. `wrangler deploy` bundles this file, `dist/worker/index.js`, and
// `src/cron.ts` together into the deployed Worker.
//
// `wrangler types` pulls this entry into the typecheck program (via
// `mainModule: typeof import("./worker")` in worker-configuration.d.ts), so it
// must compile clean. The line below is the one exception: `dist/worker/index.js`
// is an untyped build artifact that only exists after `npm run build` — tsc
// cannot resolve or type it, so the import is deliberately suppressed.
// @ts-ignore -- generated build artifact, no declarations
import pagesWorker from "./dist/worker/index.js"
import { scheduled } from "./src/cron.js"

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => pagesWorker.fetch(request, env, ctx),
  scheduled,
}

export default handler
