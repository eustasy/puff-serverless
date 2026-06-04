// Minimal in-memory KVNamespace for unit tests. Implements only the surface
// `src/oauth-keys*.ts` uses today: get(key, "json"), put(key, value, options),
// delete(key). `expirationTtl` is recorded so tests can assert on it but not
// enforced — tests advance time explicitly when they need to.

interface KVRecord {
  value: string
  expirationTtl?: number
}

export interface FakeKV extends KVNamespace {
  _store: Map<string, KVRecord>
  _resetCalls(): void
  _calls: { put: Array<{ key: string; value: string; options?: unknown }> }
}

export function fakeKv(initial: Record<string, unknown> = {}): FakeKV {
  const store = new Map<string, KVRecord>()
  const calls: FakeKV["_calls"] = { put: [] }
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, { value: typeof v === "string" ? v : JSON.stringify(v) })
  }

  const kv = {
    _store: store,
    _calls: calls,
    _resetCalls() {
      calls.put = []
    },
    async get(key: string, typeOrOpts?: unknown) {
      const record = store.get(key)
      if (!record) return null
      const type = typeof typeOrOpts === "string" ? typeOrOpts : ((typeOrOpts as { type?: string })?.type ?? "text")
      if (type === "json") return JSON.parse(record.value)
      return record.value
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: options?.expirationTtl })
      calls.put.push({ key, value, options })
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list() {
      return {
        list_complete: true,
        keys: Array.from(store.keys()).map((name) => ({ name })),
      }
    },
    async getWithMetadata() {
      throw new Error("FakeKV.getWithMetadata: not implemented")
    },
  }
  return kv as unknown as FakeKV
}
