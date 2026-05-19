// Builds a minimal `Env` for tests. Only the bindings a given test actually
// reads need to be supplied.
//
// Overrides are keyed by `keyof Env` (so binding names are still checked) but
// values are `unknown`: `wrangler types` generates string-LITERAL types for
// `vars` declared in wrangler.jsonc (e.g. `APP_URL: "https://…eustasy.org"`),
// and tests need to pass their own stand-in values without matching those
// literals exactly.
export function fakeEnv(
  overrides: Partial<Record<keyof Env, unknown>> = {}
): Env {
  return overrides as Env
}
