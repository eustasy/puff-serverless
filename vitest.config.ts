import type { ViteUserConfigExport } from "vitest/config"

// Unit tests for the `src/` domain modules. They run in a plain Node
// environment — Node 22+ provides the `crypto` Web Crypto global the hashing
// code needs, and the `pg` client is never opened: tests pass a fake DbClient
// (see test/helpers/fake-db.ts). Endpoint/Worker-level tests, if added later,
// would want @cloudflare/vitest-pool-workers instead.
//
// This uses a type-only import + `satisfies` rather than `defineConfig` on
// purpose: importing the `vitest/config` runtime value pulls in the Vite module
// graph, which knip's config loader cannot evaluate ("Cannot use 'import.meta'
// outside a module") in this CommonJS package. A type-only import is erased at
// transpile, so knip can load this config; vitest accepts a plain object export.
export default {
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // lcov is required by the Qlty upload step (coverage/lcov.info); text
      // gives a readable summary in the CI log and locally.
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Coverage ratchet (see docs/plans/test-coverage-src.md). Floors set just
      // below the post-Tier-3 numbers so `vitest run --coverage` fails on a
      // regression. Raise these as coverage improves so the floor only ever rises.
      // Post-Tier-3 actuals: lines 99.78%, statements 99.56%, functions 98.68%,
      // branches 90.04%.
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 98,
        branches: 89,
      },
    },
  },
} satisfies ViteUserConfigExport
