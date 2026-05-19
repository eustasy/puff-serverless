// Builds a minimal `Env` for tests. Only the bindings a given test actually
// reads need to be supplied; the cast keeps callers from having to spell out
// every field of the generated `Env` type.
export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env
}
