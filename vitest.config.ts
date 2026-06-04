import { defineConfig } from "vitest/config"

// Unit tests for the `src/` domain modules. They run in a plain Node
// environment — Node 22+ provides the `crypto` Web Crypto global the hashing
// code needs, and the `pg` client is never opened: tests pass a fake DbClient
// (see test/helpers/fake-db.ts). Endpoint/Worker-level tests, if added later,
// would want @cloudflare/vitest-pool-workers instead.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // lcov is required by the Qlty upload step (coverage/lcov.info); text
      // gives a readable summary in the CI log and locally.
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
})
