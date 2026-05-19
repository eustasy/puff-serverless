// A fake `pg` client for unit-testing `src/` domain modules without a real
// database. Every `src/` function takes `dbClient` as its first parameter and
// only ever calls `.query()`, so a stand-in that records calls and returns
// scripted results is enough.
//
// Usage:
//
//   const db = new FakeDb()
//   db.on(/SELECT .* FROM users/, { rows: [{ user_uuid: "u1" }] })
//   const result = await readUser(db.client, "u1")
//   expect(db.calls[0].values).toEqual(["u1"])
//
// Transaction-control statements (BEGIN/COMMIT/ROLLBACK) need no rule — they
// resolve to an empty result by default. Any other unmatched query throws, so
// a test that forgets to script a query fails loudly rather than silently.

interface FakeResult {
  rows?: unknown[]
  rowCount?: number | null
}

// A rule's response: a fixed result, an Error to reject with, or a function of
// the query's bound values returning either.
type Responder =
  | FakeResult
  | Error
  | ((values: unknown[]) => FakeResult | Error)

interface Rule {
  match: RegExp
  responder: Responder
  /** Cleared once consumed when the rule is registered as `once`. */
  once: boolean
  used: boolean
}

export interface QueryCall {
  text: string
  values: unknown[]
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class FakeDb {
  /** Every query the code under test issued, in order. */
  readonly calls: QueryCall[] = []
  private readonly rules: Rule[] = []

  /**
   * Register a response for queries whose SQL matches `match` (a substring or
   * a RegExp). Rules are tested in registration order; the first match wins.
   */
  on(match: string | RegExp, responder: Responder): this {
    return this.addRule(match, responder, false)
  }

  /**
   * Like `on`, but the rule fires only once — useful when the same statement
   * is issued twice in a transaction retry and each pass needs a different
   * result (e.g. a serialization failure followed by success).
   */
  once(match: string | RegExp, responder: Responder): this {
    return this.addRule(match, responder, true)
  }

  private addRule(
    match: string | RegExp,
    responder: Responder,
    once: boolean
  ): this {
    this.rules.push({
      match:
        typeof match === "string" ? new RegExp(escapeRegExp(match)) : match,
      responder,
      once,
      used: false,
    })
    return this
  }

  /** The fake client to pass as the `dbClient` argument. */
  get client(): DbClient {
    return {
      query: (...args: unknown[]) => this.query(args),
    } as unknown as DbClient
  }

  private async query(args: unknown[]): Promise<FakeResult> {
    const [first, second] = args
    const text =
      typeof first === "string" ? first : (first as { text: string }).text
    const values =
      typeof first === "string"
        ? ((second as unknown[]) ?? [])
        : ((first as { values?: unknown[] }).values ?? [])

    this.calls.push({ text, values })

    const rule = this.rules.find(
      (r) => !(r.once && r.used) && r.match.test(text)
    )
    if (!rule) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`FakeDb: no rule registered for query:\n${text}`)
    }
    rule.used = true

    const resolved =
      typeof rule.responder === "function"
        ? rule.responder(values)
        : rule.responder
    if (resolved instanceof Error) throw resolved

    return {
      rows: resolved.rows ?? [],
      rowCount: resolved.rowCount ?? resolved.rows?.length ?? 0,
    }
  }
}

/**
 * Builds an Error shaped like a `pg` driver error carrying a SQLSTATE `code`.
 * Handy for exercising error branches — e.g. `pgError("40001")` for a
 * CockroachDB serialization failure.
 */
export function pgError(code: string, message = `pg error ${code}`): Error {
  return Object.assign(new Error(message), { code })
}
