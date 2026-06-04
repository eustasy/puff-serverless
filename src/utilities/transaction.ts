// CockroachDB runs every transaction at SERIALIZABLE isolation. When it cannot
// order a transaction against a concurrent one it aborts the loser with a
// *retryable* error (SQLSTATE 40001 / RETRY_SERIALIZABLE — "restart
// transaction") and expects the client to rerun the whole transaction.
//
// A multi-statement transaction issued over separate round-trips
// (BEGIN; ...; COMMIT) cannot be retried server-side — the client has already
// consumed results — so the retry has to happen here. Single auto-committed
// statements outside an explicit transaction are auto-retried by the server
// and need no wrapping.

// SQLSTATE for a serialization failure. Both real CockroachDB serialization
// aborts and Postgres-compatible serialization failures use this code.
const SERIALIZATION_FAILURE = "40001"

// Total attempts (1 initial + up to 4 retries) before giving up.
const MAX_ATTEMPTS = 5

function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === SERIALIZATION_FAILURE
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Thrown from within a `runInTransaction` callback to abort the transaction
 * (ROLLBACK) and have `runInTransaction` resolve with `value` instead of
 * rethrowing. Use this for business-rule aborts — e.g. a not-found row or a
 * limit hit after a write has already been issued — so a partial transaction
 * is not committed. It is never treated as a retryable error.
 */
export class Rollback<T> {
  constructor(public readonly value: T) {}
}

/**
 * Runs `work` inside a single BEGIN/COMMIT transaction, retrying the whole
 * transaction on a CockroachDB serialization failure (SQLSTATE 40001).
 *
 * `work` must NOT issue its own BEGIN/COMMIT/ROLLBACK — this helper owns the
 * transaction boundary. To abort the transaction with a non-error result,
 * `throw new Rollback(value)`; `runInTransaction` then rolls back and resolves
 * with `value`. Any other thrown error rolls back and, if retryable and
 * attempts remain, retries; otherwise it is rethrown.
 *
 * `work` may run more than once, so it must be safe to repeat (no external
 * side effects that cannot be replayed).
 *
 * @param dbClient - An active pg.Client instance.
 * @param work - The transaction body. Its return value is resolved on COMMIT.
 */
export async function runInTransaction<T>(dbClient: DbClient, work: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await dbClient.query("BEGIN")
    try {
      const result = await work()
      await dbClient.query("COMMIT")
      return result
    } catch (error) {
      // `.catch` so a rollback failure (e.g. already-aborted transaction)
      // does not shadow the original error.
      await dbClient.query("ROLLBACK").catch(() => {})

      if (error instanceof Rollback) {
        return (error as Rollback<T>).value
      }

      if (isRetryable(error) && attempt < MAX_ATTEMPTS) {
        lastError = error
        // Exponential backoff with jitter so competing writers don't
        // lock-step into repeated collisions.
        await sleep(2 ** attempt * 5 + Math.random() * 10)
        continue
      }

      throw error
    }
  }
  // Unreachable in practice: the final attempt either returns or throws above.
  throw lastError
}
