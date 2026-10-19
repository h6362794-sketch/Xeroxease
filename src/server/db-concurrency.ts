// Bounded concurrency for multi-query read paths.
//
// Prisma's own knob for parallel work is the connection pool, configured through
// `connection_limit` in DATABASE_URL. A route that builds every query promise up
// front (the usual `Promise.all([...])`) submits them all to the pool at once,
// whatever that limit is. When the limit is small — production currently runs a
// singleton client with `connection_limit=1` — all but one of those queries
// become waiters, and Prisma rejects a waiter that is not served within
// `pool_timeout` (default 10 s) with:
//
//   P2024: Timed out fetching a new connection from the connection pool
//
// Admin analytics is the extreme case: one request fires fifteen queries, and the
// dashboard re-requests them every 30 s. Batching the calls keeps the queue
// behind a single pooled connection short and predictable, instead of a burst of
// fourteen waiters whose wait time grows with database latency.
//
// This is a mitigation, not a substitute for a correctly sized pool: the pool
// size itself is an operator decision (DATABASE_URL), and `diagnoseDatabaseConfig`
// warns about `connection_limit=1`.

/** Maximum number of database queries this process starts at once per route. */
export const DB_QUERY_CONCURRENCY = 4;

/**
 * Await lazily-built tasks in batches of at most `limit`.
 *
 * Tasks must be thunks, not already-created promises: a promise starts its work
 * the moment it is created, so accepting promises here would not bound anything.
 * Results keep their tuple positions, so destructuring is fully typed.
 */
export async function runWithDbConcurrency<
  // `const` forces the array literal to be inferred as a tuple instead of a
  // homogeneous array, so each result keeps the type of its own query. Without
  // it every destructured variable becomes the union of all query results.
  const T extends readonly (() => Promise<unknown>)[],
>(tasks: T, limit: number = DB_QUERY_CONCURRENCY): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  // `-readonly` matters: `T` is usually inferred from a `readonly` tuple literal,
  // and a readonly mapped type cannot be written to.
  type Results = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
  const results = new Array(tasks.length) as unknown as Results;

  const bound = Math.max(1, Math.min(Math.floor(limit), tasks.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = (await tasks[index]()) as Results[typeof index];
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}
